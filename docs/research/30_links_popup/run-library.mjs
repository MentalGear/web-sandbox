// Variant 7 of research 30: the library itself, sealed mode, the default build at its default configuration. The guest
// renders a button, listens with sandboxView.on('click', ...) and calls a host method through the bridge; the method the
// embedder exposes calls window.open(url, '_blank', 'noopener,noreferrer'). The path is the library's own: view frame
// (in the wrapper frame, in the element's closed shadow root) -> relay and guest worker -> host page.
//
//   bun scripts/build-lib.ts      (writes dist/index.js, the default build; the probe reads it from --dist=<dir>)
//   node docs/research/30_links_popup/run-library.mjs --dist=<dir with index.js> --engine=chromium,firefox,webkit [--reps=5]
//        [--variants=7,7@1000,...] [--headed]
//
// As probe.mjs: one fresh context per run, real input, nothing evaluated in the page, the page reports to the server.
import { readFileSync } from 'node:fs';
import { ENGINES, HOST_ORIGIN, TARGET_ORIGIN, emit, engineName, sleep, startServers, watchTabs } from './lib.mjs';

const arg = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const headed = process.argv.includes('--headed');
const reps = Number(arg('reps', '5'));
const engines = arg('engine', 'chromium,firefox,webkit').split(',');
const dist = arg('dist', '');
if (!dist) throw new Error('--dist=<directory with the default build\'s index.js>');

// The element is at (20, 20), 400 x 300; the view's button (display:block, 300 x 200) sits at the body's 8 px margin.
const ELEMENT = { x: 20, y: 20, w: 400, h: 300 };
const CLICK = { x: ELEMENT.x + 8 + 150, y: ELEMENT.y + 8 + 100 };
const HOST_CLICK = { x: 600, y: 500 }; // the host page's own background, outside the element
const VIEW_BLANK_CLICK = { x: ELEMENT.x + 380, y: ELEMENT.y + 280 }; // inside the element, in the view, off the button

const GUEST = `
sandboxView.render('<button id="go" style="display:block;width:300px;height:200px">Open</button>');
sandboxView.on('click', 'go', () => { bridge.call('openLink', Date.now()).catch(() => {}); });
bridge.call('ready').catch(() => {});
// variants 8 to 10: the guest asks by itself, TIMER ms after it starts, whatever the user did
const TIMER = __TIMER__;
if (TIMER) setTimeout(() => { bridge.call('openLink', Date.now()).catch(() => {}); }, TIMER);
`;

const literal = (text) => JSON.stringify(text).replaceAll('</', '<\\/');

const hostPage = () => `<!doctype html><meta charset="utf-8"><title>r30 library</title><body style="margin:0"><script type="module">
import { defineWebSandbox } from '/dist/index.js';
const Q = new URLSearchParams(location.search);
const TIMER = Number(Q.get('timer') || 0);
const ID = Q.get('id'), DELAY = Number(Q.get('delay') || 0), COUNT = Number(Q.get('count') || 1), GAP = Number(Q.get('gap') || 0);
const report = (entry) => fetch('/log?id=' + ID, { method: 'POST', body: JSON.stringify({ t: Date.now(), ...entry }), keepalive: true });
const activation = () => navigator.userActivation ? { isActive: navigator.userActivation.isActive, hasBeenActive: navigator.userActivation.hasBeenActive } : null;
let counter = 0;
function openOnce(clickTs) {
    const n = ++counter;
    const before = activation();
    let returned, threw = null;
    try { returned = window.open('${TARGET_ORIGIN}/target?id=' + ID + '&n=' + n, '_blank', 'noopener,noreferrer'); } catch (error) { threw = String(error); }
    report({ ev: 'open', n, before, after: activation(), sinceClick: Date.now() - clickTs, returned: returned === null ? 'null' : typeof returned, threw });
}
defineWebSandbox();
const sandbox = document.createElement('web-sandbox');
sandbox.style.cssText = 'position:fixed;left:${ELEMENT.x}px;top:${ELEMENT.y}px;width:${ELEMENT.w}px;height:${ELEMENT.h}px';
document.body.append(sandbox);
sandbox.addEventListener('sandbox-error', (e) => report({ ev: 'sandbox-error', detail: String(e.detail && (e.detail.reason || e.detail.message)) }));
sandbox.registerFiles({ 'app.js': ${literal(GUEST)}.replace('__TIMER__', String(TIMER)) });
sandbox.expose('ready', () => { report({ ev: 'ready', act: activation() }); });
sandbox.expose('openLink', (clickTs) => {
    report({ ev: 'request', act: activation(), delay: DELAY });
    for (let i = 0; i < COUNT; i++) {
        const at = DELAY + i * GAP;
        if (at === 0) openOnce(clickTs);
        else setTimeout(() => openOnce(clickTs), at);
    }
});
sandbox.setConfig({ entry: 'app.js' });
</script>`;

const VARIANTS = {
    7: {},
    '7@500': { delay: 500 },
    '7@1000': { delay: 1000 },
    '7@3000': { delay: 3000 },
    '7@6000': { delay: 6000 },
    '7twice': { count: 2, gap: 0, clicks: 2 },
    // no click: the guest asks 1 s after it starts, and nobody clicked
    8: { timer: 1000, clicks: 0 },
    // a click on the host page, outside the element, 0.5 s after the guest is ready; the guest asks 2 s after it starts
    9: { timer: 2000, clicks: 0, elsewhere: HOST_CLICK },
    // a click inside the element, in the view but off the button, then the same request
    10: { timer: 2000, clicks: 0, elsewhere: VIEW_BLANK_CLICK },
    // as 9, the guest asks 6 s after it starts: the click is 5.5 s old
    '9late': { timer: 6000, clicks: 0, elsewhere: HOST_CLICK },
};
const wanted = arg('variants', '7,7@500,7@1000,7@3000,7@6000,7twice,8,9,10,9late').split(',');

const server = await startServers();
server.route('/host', { body: hostPage() });
server.route('/dist/index.js', { type: 'text/javascript; charset=utf-8', body: readFileSync(`${dist}/index.js`, 'utf8') });

async function waitFor(condition, label, ms = 20000) {
    for (let waited = 0; waited < ms; waited += 50) {
        if (condition()) return;
        await sleep(50);
    }
    throw new Error(`timeout: ${label}`);
}

async function oneRun(browser, engine, name, spec, rep) {
    const id = `${engine}-${name}-${rep}-${Math.random().toString(36).slice(2, 8)}`;
    const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
    const page = await context.newPage();
    const tabs = watchTabs(context);
    const query = new URLSearchParams({ id, timer: spec.timer ?? 0, delay: spec.delay ?? 0, count: spec.count ?? 1, gap: spec.gap ?? 0 });
    await page.goto(`${HOST_ORIGIN}/host?${query}`);
    await waitFor(() => server.logsOf(id).some((e) => e.ev === 'ready'), 'ready');
    await sleep(500);
    const afterClick = [];
    const settle = (spec.delay ?? 0) + ((spec.count ?? 1) - 1) * (spec.gap ?? 0) + (spec.timer ?? 0) + 2500;
    // a click that is not on the button (or none): the guest's own timer makes the request
    if (spec.elsewhere) await page.mouse.click(spec.elsewhere.x, spec.elsewhere.y);
    if (spec.timer) {
        await sleep(settle);
        afterClick.push({ hits: server.hitsOf(id).map((h) => Number(h.n)), tabs: tabs.length });
    }
    for (let i = 0; i < (spec.clicks ?? 1); i++) {
        await page.mouse.click(CLICK.x, CLICK.y);
        await sleep(settle);
        afterClick.push({ hits: server.hitsOf(id).map((h) => Number(h.n)), tabs: tabs.length });
    }
    const logs = server.logsOf(id);
    const run = {
        engine, variant: name, rep,
        opens: logs.filter((e) => e.ev === 'open').map(({ n, before, after, sinceClick, returned, threw }) => ({ n, before, after, sinceClick, returned, threw })),
        request: logs.filter((e) => e.ev === 'request').map((e) => e.act),
        errors: logs.filter((e) => e.ev === 'sandbox-error').map((e) => e.detail),
        afterClick,
        hits: server.hitsOf(id).length,
        tabs: tabs.length,
    };
    await context.close();
    return run;
}

for (const key of engines) {
    const browser = await ENGINES[key](headed);
    emit('run', { engine: key, version: browser.version(), headed, date: new Date().toISOString(), reps, dist });
    for (const name of wanted) {
        const spec = VARIANTS[name];
        if (!spec) throw new Error(`no variant ${name}`);
        for (let rep = 1; rep <= reps; rep++) {
            try {
                emit('result', await oneRun(browser, engineName(key) + (key === 'shell' ? '-shell' : ''), name, spec, rep));
            } catch (error) {
                emit('error', { engine: key, variant: name, rep, message: String(error).slice(0, 200) });
            }
        }
    }
    await browser.close();
}
server.close();
