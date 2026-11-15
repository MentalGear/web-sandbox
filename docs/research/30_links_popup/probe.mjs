// Variants 1 to 6 of research 30: does the browser's popup blocker, switched on, let a host page open a tab with
// window.open(url, '_blank', 'noopener,noreferrer') when the user's click happened in a nested sandboxed frame and the
// call runs after hops over ports and a worker?
//
//   bun docs/research/30_links_popup/probe.mjs --engine=chromium,firefox,webkit [--reps=5] [--variants=1pos,1neg,...] [--headed]
//   (--engine=shell is Chromium's headless shell; --headed needs a display: xvfb-run -a bun ...)
//   bun docs/research/30_links_popup/probe.mjs --serve-only    (the pages of every variant, for a browser Playwright cannot drive)
//
// One JSON line per run on stdout. A run is one fresh browser context and one page, loaded from the host server; the
// click is real input (page.mouse.click at coordinates inside the frame). Nothing is evaluated in the page between its
// load and the end of the run (an evaluate can carry a user gesture): the page reports to the server by itself.
import { ENGINES, HOST_ORIGIN, TARGET_ORIGIN, emit, engineName, sleep, startServers, watchTabs } from './lib.mjs';

const arg = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const headed = process.argv.includes('--headed');
const reps = Number(arg('reps', '5'));
const engines = arg('engine', 'chromium,firefox,webkit').split(',');
// how long after the last scheduled open the run reads the recorder; the default leaves a tab ample time to load
const tail = Number(arg('tail', '2000'));

/** The geometry every shape shares: the frame (or the host page's own box) at (20, 20), 300 x 200; the click is at its middle. */
const BOX = { x: 20, y: 20, w: 300, h: 200 };
const CLICK = { x: BOX.x + BOX.w / 2, y: BOX.y + BOX.h / 2 };

// A string for the host page's inline script: `</` is escaped so that a document in it cannot end that script early.
const literal = (text) => JSON.stringify(text).replaceAll('</', '<\\/');

// The view's document: a box over the whole frame; on the port it is given it reports a click and its own readiness.
const VIEW_SRC = `<!doctype html><body style="margin:0"><div id="b" style="width:100vw;height:100vh;background:#9cf">view</div><script>
addEventListener('message', (e) => {
    const port = e.ports[0];
    if (!port) return;
    document.getElementById('b').onclick = () => port.postMessage({ type: 'click', ts: Date.now() });
    port.postMessage({ type: 'ready' });
});<\/script>`;

// The wrapper: creates the view frame (sandboxed srcdoc) and hands the port it received on to it.
const WRAPPER_SRC = `<!doctype html><body style="margin:0"><script>
addEventListener('message', (e) => {
    const port = e.ports[0];
    const view = document.createElement('iframe');
    view.setAttribute('sandbox', 'allow-scripts');
    view.style.cssText = 'border:0;display:block;width:100vw;height:100vh';
    view.srcdoc = ${literal(VIEW_SRC)};
    view.onload = () => view.contentWindow.postMessage('init', '*', [port]);
    document.body.append(view);
}, { once: true });<\/script>`;

// The worker: relays what the view sends on the one port to the host on the other.
const WORKER_SRC = `onmessage = (e) => {
    const [fromView, toHost] = e.ports;
    fromView.onmessage = (m) => toHost.postMessage(m.data);
};`;

/** The host page. `shape`: pos (the host's own box), neg (a timer, no gesture), direct, nested, worker. */
function hostPage() {
    return `<!doctype html><meta charset="utf-8"><title>r30</title><body style="margin:0"><script>
const Q = new URLSearchParams(location.search);
const ID = Q.get('id'), SHAPE = Q.get('shape'), DELAY = Number(Q.get('delay') || 0), COUNT = Number(Q.get('count') || 1), GAP = Number(Q.get('gap') || 0);
const BOX = ${JSON.stringify(BOX)};
const report = (entry) => fetch('/log?id=' + ID, { method: 'POST', body: JSON.stringify({ t: Date.now(), ...entry }), keepalive: true });
const activation = () => navigator.userActivation ? { isActive: navigator.userActivation.isActive, hasBeenActive: navigator.userActivation.hasBeenActive } : null;
let counter = 0;

function openOnce(clickTs) {
    const n = ++counter;
    const before = activation();
    let returned, threw = null;
    try { returned = window.open('${TARGET_ORIGIN}/target?id=' + ID + '&n=' + n, '_blank', 'noopener,noreferrer'); } catch (error) { threw = String(error); }
    report({ ev: 'open', n, before, after: activation(), sinceClick: clickTs ? Date.now() - clickTs : null, returned: returned === null ? 'null' : typeof returned, threw });
}

// the request: COUNT opens, the first after DELAY, the others GAP apart; a delay of 0 is the same task, synchronously
function request(clickTs) {
    report({ ev: 'request', act: activation(), delay: DELAY });
    for (let i = 0; i < COUNT; i++) {
        const at = DELAY + i * GAP;
        if (at === 0) openOnce(clickTs);
        else setTimeout(() => openOnce(clickTs), at);
    }
}

function frameAt(srcdoc) {
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.style.cssText = 'position:fixed;border:0;left:' + BOX.x + 'px;top:' + BOX.y + 'px;width:' + BOX.w + 'px;height:' + BOX.h + 'px';
    frame.srcdoc = srcdoc;
    // the frame lives in a closed shadow root, as the library's view does
    const holder = document.createElement('div');
    document.body.append(holder);
    holder.attachShadow({ mode: 'closed' }).append(frame);
    return frame;
}

function onHostPort(port) {
    port.onmessage = (m) => {
        if (m.data.type === 'ready') report({ ev: 'ready', act: activation() });
        if (m.data.type === 'click') request(m.data.ts);
    };
}

if (SHAPE === 'pos') {
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;background:#9cf;left:' + BOX.x + 'px;top:' + BOX.y + 'px;width:' + BOX.w + 'px;height:' + BOX.h + 'px';
    box.onclick = () => request(Date.now());
    document.body.append(box);
    report({ ev: 'ready', act: activation() });
} else if (SHAPE === 'neg') {
    // no click is ever made; the timer is the call the blocker must stop
    setTimeout(() => openOnce(null), 500);
    report({ ev: 'ready', act: activation() });
} else if (SHAPE === 'direct') {
    const channel = new MessageChannel();
    onHostPort(channel.port1);
    const frame = frameAt(${literal(VIEW_SRC)});
    frame.onload = () => frame.contentWindow.postMessage('init', '*', [channel.port2]);
} else {
    const toView = new MessageChannel();
    const toHost = new MessageChannel();
    let viewPort = toView.port2, hostPort = toHost.port1;
    if (SHAPE === 'worker') {
        const worker = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(WORKER_SRC)}], { type: 'text/javascript' })));
        // the view's port ends in the worker, whose other port goes on to the host
        worker.postMessage('init', [toView.port1, toHost.port2]);
    } else {
        viewPort = toHost.port2;
    }
    onHostPort(hostPort);
    const frame = frameAt(${literal(WRAPPER_SRC)});
    frame.onload = () => frame.contentWindow.postMessage('init', '*', [viewPort]);
}
</script>`;
}

const VARIANTS = {
    '1pos': { shape: 'pos' },
    '1neg': { shape: 'neg', click: false },
    '1async': { shape: 'pos', delay: 100 },
    2: { shape: 'direct' },
    3: { shape: 'nested' },
    4: { shape: 'worker' },
    6: { shape: 'worker', count: 2, gap: 0, clicks: 2 },
    '6gap100': { shape: 'worker', count: 2, gap: 100, clicks: 2 },
};
// variant 5: 4 with a delay before the host opens
for (const delay of [0, 100, 500, 1000, 1500, 2000, 3000, 4000, 4500, 5000, 5500, 6000, 8000]) VARIANTS[`5@${delay}`] = { shape: 'worker', delay };
for (const delay of [10, 20, 50, 250, 750, 1250, 2500, 3500]) VARIANTS[`5@${delay}`] = { shape: 'worker', delay };

const wanted = arg('variants', '1pos,1neg,1async,2,3,4,5@0,5@100,5@500,5@1000,5@3000,5@6000,6,6gap100').split(',');
const serveOnly = process.argv.includes('--serve-only');
const server = await startServers(serveOnly ? (kind, entry) => console.log(JSON.stringify({ kind, ...entry })) : undefined);
server.route('/host', { body: hostPage() });

// --serve-only: no browser; the pages stay up on loopback for a person to open in a browser Playwright cannot drive (Safari),
// click the blue box with the mouse, and read each log entry and hit as it arrives. Stop it with Ctrl-C.
if (serveOnly) {
    for (const [name, spec] of Object.entries(VARIANTS)) {
        const query = new URLSearchParams({ id: `manual-${name}`, shape: spec.shape, delay: spec.delay ?? 0, count: spec.count ?? 1, gap: spec.gap ?? 0 });
        console.log(`${name}: ${HOST_ORIGIN}/host?${query}`);
    }
    await new Promise(() => {});
}

async function waitFor(condition, label, ms = 15000) {
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
    const query = new URLSearchParams({ id, shape: spec.shape, delay: spec.delay ?? 0, count: spec.count ?? 1, gap: spec.gap ?? 0 });
    await page.goto(`${HOST_ORIGIN}/host?${query}`);
    await waitFor(() => server.logsOf(id).some((e) => e.ev === 'ready'), 'ready');
    await sleep(300);
    const afterClick = [];
    const clicks = spec.click === false ? 0 : (spec.clicks ?? 1);
    const settle = (spec.delay ?? 0) + ((spec.count ?? 1) - 1) * (spec.gap ?? 0) + tail;
    for (let i = 0; i < clicks; i++) {
        await page.mouse.click(CLICK.x, CLICK.y);
        await sleep(settle);
        afterClick.push({ hits: server.hitsOf(id).map((h) => Number(h.n)), tabs: tabs.length });
    }
    if (clicks === 0) {
        await sleep(tail + 500);
        afterClick.push({ hits: server.hitsOf(id).map((h) => Number(h.n)), tabs: tabs.length });
    }
    const logs = server.logsOf(id);
    const run = {
        engine, variant: name, rep,
        opens: logs.filter((e) => e.ev === 'open').map(({ n, before, after, sinceClick, returned, threw }) => ({ n, before, after, sinceClick, returned, threw })),
        request: logs.filter((e) => e.ev === 'request').map((e) => e.act),
        ready: logs.find((e) => e.ev === 'ready')?.act,
        afterClick,
        hits: server.hitsOf(id).length,
        tabs: tabs.length,
    };
    await context.close();
    return run;
}

for (const key of engines) {
    const browser = await ENGINES[key](headed);
    emit('run', { engine: key, version: browser.version(), headed, date: new Date().toISOString(), reps });
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
