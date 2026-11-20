// Research 34's Electron probe against the library (design 05, row 3.10): the default build's `defineWebSandbox()` and
// sealed mode in Electron's window (electron/main.cjs: Electron's default webPreferences, and `app:` registered as a
// standard, secure scheme with fetch support), with `sealed-document.html` beside the host page on its own scheme:
// `file:`, `app://bundle`, and `http` as the baseline. For each host page:
//
//   origin    the page's own origin as it reads it (`self.origin`), which the rule decides by
//   refused   each documentUrl the rule must refuse there: another origin off http(s) (the other scheme's file, a
//             `data:` document, a `blob:` URL the page minted)
//   defined   `defineWebSandbox({ documentUrl: 'sealed-document.html' })`, the file beside the page, and the URL stored
//   app       a sealed app started on that registration: `ready`, then a call answered by the guest's worker
//   check     the check of the file on that scheme: a page whose documentUrl is a copy with one byte more ends with the
//             reason for other bytes, before anything is framed, where the host page can read the file
//   guard     I14: the file framed by the host page itself without `sandbox`, with `allow-same-origin`, and as the
//             element frames it: how many frames the file's document holds once it loaded (the view is its one frame;
//             the guard stops the file before the view's markup where the file is not opaque)
//
// Needs today's default build in dist/ (`bun run build:lib`) and Electron in electron/ (`cd
// docs/research/34_non_http_host/electron && bun install && node node_modules/electron/install.js`); the container has
// no display, so the run goes under Xvfb. From the repository root:
//
//   xvfb-run -a bun docs/research/34_non_http_host/probe-electron-library.mjs
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { _electron } from 'playwright';
import { emit } from '../28_served_topology/lib.mjs';
import { startStatic } from './server.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(dir, '../../..');
const site = path.join(dir, 'site', 'library');
const app = path.join(site, 'app');

// The site: the library as published, its file, a copy of the file with one byte more, and one host page.
rmSync(site, { recursive: true, force: true });
mkdirSync(path.join(app, 'lib'), { recursive: true });
cpSync(path.join(repo, 'dist/index.js'), path.join(app, 'lib/index.js'));
const file = readFileSync(path.join(repo, 'dist/sealed-document.html'), 'utf8');
writeFileSync(path.join(app, 'sealed-document.html'), file);
writeFileSync(path.join(app, 'sealed-document-changed.html'), `${file}\n`);
writeFileSync(path.join(app, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><title>r34 library</title></head><body></body></html>');

const srv = await startStatic(site);
const electronApp = await _electron.launch({
    executablePath: path.join(dir, 'electron/node_modules/electron/dist/electron'),
    args: ['--no-sandbox', path.join(dir, 'electron/main.cjs')],
    env: { ...process.env, R34_SITE: site, NODE_OPTIONS: '' },
});
const versions = await electronApp.evaluate(() => ({ electron: process.versions.electron, chrome: process.versions.chrome }));
emit('r34lib.run', { engine: 'electron', version: `Electron ${versions.electron} (Chromium ${versions.chrome})`, date: new Date().toISOString() });
const page = await electronApp.firstWindow();
page.on('console', (message) => emit('r34lib.console', { type: message.type(), text: message.text().slice(0, 300) }));

const fileBase = pathToFileURL(app).href;
const KINDS = [
    { kind: 'electron file: host', base: fileBase, other: 'app://bundle/sealed-document.html' },
    { kind: 'electron app: host', base: 'app://bundle', other: `${fileBase}/sealed-document.html` },
    { kind: 'electron http host (baseline)', base: `${srv.local}/app`, other: `${fileBase}/sealed-document.html` },
];

// In the page: imports the library, tries each refused URL, defines the element with `documentUrl`, starts a sealed
// app and calls it.
const RUN = async ({ documentUrl, refused }) => {
    const out = { origin: self.origin, refused: {} };
    const { defineWebSandbox } = await import('./lib/index.js');
    for (const [name, url] of Object.entries(refused)) {
        const value = url === 'blob' ? URL.createObjectURL(new Blob(['<!doctype html>'], { type: 'text/html' })) : url;
        try { defineWebSandbox({ documentUrl: value }); out.refused[name] = 'defined'; } catch (error) { out.refused[name] = `${error.name}: ${error.message}`; }
    }
    try { defineWebSandbox({ documentUrl }); } catch (error) { out.defined = `${error.name}: ${error.message}`; return out; }
    out.defined = new URL(documentUrl, document.URL).href;
    const el = document.createElement('web-sandbox');
    el.style.cssText = 'display:block;width:400px;height:300px';
    const started = performance.now();
    out.app = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve('no answer in 20 s'), 20000);
        el.addEventListener('terminated', (event) => { clearTimeout(timer); resolve(`terminated: ${event.detail.reason}`); }, { once: true });
        el.addEventListener('ready', async () => {
            try { resolve(`ready, call answered ${await el.call('ping')}`); } catch (error) { resolve(`ready, call failed: ${error.message}`); } finally { clearTimeout(timer); }
        }, { once: true });
        el.start({ html: '<p id="hello">hello</p>', entry: 'app.js', files: { 'app.js': 'sandboxView.text("hello", "written"); bridge.expose("ping", () => "pong");' } });
        document.body.append(el);
    });
    out.ms = Math.round(performance.now() - started);
    return out;
};

// In the page: frames the file itself with each `sandbox` attribute, and counts the frames of the file's document once
// it loaded (the view is the file's one frame; none where the guard stopped the file).
const GUARD = async ({ url }) => {
    const out = {};
    for (const [name, sandbox] of [['without sandbox', null], ['with allow-same-origin', 'allow-scripts allow-same-origin allow-forms'], ['as the element frames it', 'allow-scripts allow-forms']]) {
        const frame = document.createElement('iframe');
        if (sandbox !== null) frame.setAttribute('sandbox', sandbox);
        frame.src = url;
        const loaded = new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }));
        document.body.append(frame);
        await loaded;
        await new Promise((resolve) => setTimeout(resolve, 300));
        let readable;
        try { readable = frame.contentDocument ? 'the host page reads the file\'s document' : 'not readable'; } catch { readable = 'not readable'; }
        out[name] = { frames: frame.contentWindow.length, readable };
        frame.remove();
    }
    return out;
};

for (const { kind, base, other } of KINDS) {
    try {
        await page.goto(`${base}/index.html`);
        const refused = { 'the other scheme\'s file': other, 'a data: document': 'data:text/html,<p>x</p>', 'a blob: URL of its own': 'blob' };
        emit('r34lib.host', { kind, ...(await page.evaluate(RUN, { documentUrl: 'sealed-document.html', refused })) });
        await page.goto(`${base}/index.html`);
        emit('r34lib.check', { kind, ...(await page.evaluate(RUN, { documentUrl: 'sealed-document-changed.html', refused: {} })) });
        await page.goto(`${base}/index.html`);
        emit('r34lib.guard', { kind, ...(await page.evaluate(GUARD, { url: `${base}/sealed-document.html` })) });
    } catch (error) {
        emit('r34lib.error', { kind, error: String(error).slice(0, 400) });
    }
}
await electronApp.close();
await srv.close();
process.exit(0);
