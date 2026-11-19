// Research 33: does a real `href` on a listed link in the view make the browser fetch anything before the click?
//
//   node docs/research/33_link_href/probe.mjs <config> [--plan=full|reduced|lite|real|guards|dns] [--headed] [--cases=a,b] [--layouts=view,open]
//          [--reps=N] [--only=hover|press|tab|focus|touch|context] [--via=direct|proxy] [--dns] [--context] [--real] [--hold=ms]
//
// <config> is one of CONFIGS below (the engine and what the launch changes). Each trial is a fresh browser context and
// page, and runs these phases in order, each a window of time; every connection the recorder sees is filed under the
// phase in whose window it was accepted:
//   render   the page loaded, the link below the view's fold, 1.5 s
//   scroll   the link scrolled into view, 2.5 s
//   hover    the pointer moved onto the link and rests 2 s, then leaves (0.7 s)
//   tab      focus by keyboard: Tab from the host page until the link has focus, 1.2 s, then blur
//   focus    focus by script (`focus()`), 1.2 s, then blur
//   press    pointer down on the link, held 1 s
//   drag     then moved away, off the link, and released in the view's document (a drag and a drop), 1 s: no click
//   touch    (Chromium only, through CDP) a touch start on the link, 1 s, then a touch cancel
//   context  a right click on the link (the context menu), 1.2 s, then Escape
//   click    the control: a left click. The view cancels it and the host page opens the listed URL in a new tab, so a
//            request to the listed host must appear; if none does, the recorder is not seeing the engine's traffic.
// `--only=<phase>` runs render, that phase and the click (the isolated form of a phase).
// `--dns`: the listed host bypasses the proxy, so the browser resolves it itself; run under strace by dns.mjs, which
// files every DNS query by its time (the phases' times are in the output) and its name (the trial is in the name).
import { chromium, firefox, webkit } from 'playwright';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CASES, LISTED, linkUrl, listedHost } from './fixture.mjs';
import { installRoutes } from './fixture.mjs';
import { startRecorder } from './recorder.mjs';

const pkgVersion = createRequire(import.meta.url)('playwright/package.json').version;
const PW_CHROMIUM_OFF = ['--disable-field-trial-config', '--disable-background-networking'];

/** The configurations: the engine, the build, and what is changed from Playwright's launch. */
export const CONFIGS = {
    'chromium-shell': { type: chromium, options: {}, note: "headless shell, Playwright's arguments" },
    'chromium-full': { type: chromium, options: { channel: 'chromium' }, note: "full build, Playwright's arguments" },
    'chromium-on': { type: chromium, options: { channel: 'chromium', ignoreDefaultArgs: PW_CHROMIUM_OFF }, note: 'full build without --disable-field-trial-config and --disable-background-networking' },
    firefox: { type: firefox, options: {}, note: "Playwright's prefs (network.http.speculative-parallel-limit 0)" },
    'firefox-on': { type: firefox, options: { firefoxUserPrefs: { 'network.http.speculative-parallel-limit': 6 } }, note: "Playwright's prefs with network.http.speculative-parallel-limit back at Firefox's default, 6" },
    // control of the long press: Firefox's link preview off (it is on by default: browser.ml.linkPreview.enabled,
    // .longPress, .longPressMs 1000 in the build's defaults/preferences/firefox.js)
    'firefox-on-nopreview': { type: firefox, options: { firefoxUserPrefs: { 'network.http.speculative-parallel-limit': 6, 'browser.ml.linkPreview.enabled': false } }, note: 'firefox-on with browser.ml.linkPreview.enabled false' },
    webkit: { type: webkit, options: {}, note: "Playwright's WebKit (WPE headless, GTK headed)" },
};

const args = process.argv.slice(2);
const opt = (k, d) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const flag = (k) => args.includes(`--${k}`);
const configName = args.find((a) => a in CONFIGS);
if (!configName) { console.error(`config? ${Object.keys(CONFIGS).join(' ')}`); process.exit(2); }
const config = CONFIGS[configName];
const headed = flag('headed');
const dns = flag('dns');
const only = opt('only', null);
// `--real` (headed, under xvfb-run): hover, press, drag and the click come from the X server through XTest
const real = flag('real');
// `--hold=ms`: how long the press is held before the pointer moves away (default 1000)
const hold = Number(opt('hold', 1000));
const isChromium = config.type === chromium;

const LINKS = ['plain', 'blank', 'inert', 'nohref', 'plain-nodrag', 'blank-nodrag', 'plain-nohandler', 'blank-nohandler'];
// what a view could add against a press or a drag (measured after the first full runs)
const GUARDS = ['plain-nopress', 'blank-nopress', 'plain-undraggable', 'blank-undraggable'];
const OTHERS = Object.keys(CASES).filter((c) => !LINKS.includes(c) && !GUARDS.includes(c));
const PLANS = {
    full: [['view', LINKS, 8], ['view', OTHERS, 3], ['open', [...LINKS, ...OTHERS], 2], ['nometa', [...LINKS, ...OTHERS], 1]],
    lite: [['view', ['plain', 'blank', 'inert', 'nohref'], 3], ['view', ['preconnect', 'prefetch', 'hdr-preconnect'], 1], ['open', ['plain', 'inert', 'preconnect'], 1]],
    real: [['view', ['plain', 'blank', 'inert'], 3]],
    guards: [['view', [...GUARDS, 'plain', 'inert'], 5], ['open', [...GUARDS, 'plain'], 1]],
    reduced: [['view', LINKS, 3], ['view', OTHERS, 1], ['open', [...LINKS, ...OTHERS], 1]],
    dns: [['view', ['plain', 'blank', 'inert', 'preconnect', 'dnsprefetch', 'prefetch', 'hdr-preconnect', 'hdr-dnsprefetch'], 2], ['open', ['plain', 'blank', 'inert', 'preconnect', 'dnsprefetch', 'prefetch', 'hdr-preconnect', 'hdr-dnsprefetch'], 1]],
};
let plan = PLANS[opt('plan', 'full')];
const casesArg = opt('cases', null);
const layoutsArg = opt('layouts', null);
const repsArg = opt('reps', null);
if (casesArg || layoutsArg || repsArg) {
    const cs = casesArg ? casesArg.split(',') : [...LINKS, ...OTHERS];
    const ls = layoutsArg ? layoutsArg.split(',') : ['view'];
    plan = ls.map((l) => [l, cs, Number(repsArg ?? 3)]);
}

const emit = (tag, o) => console.log(`${tag} ${JSON.stringify(o)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const load1 = () => { try { return Number(readFileSync('/proc/loadavg', 'utf8').split(' ')[0]); } catch { return 0; } };

/** The trials, round robin over cases so that load spreads over all of them. */
function trials() {
    const out = [];
    for (const [layout, cases, reps] of plan) for (let r = 0; r < reps; r++) for (const c of cases) out.push({ layout, case: c, rep: r });
    return out;
}

// A listener in the link's document (installed by Playwright, outside the page's policy) that records what reached the
// link, so a phase whose input never arrived is not read as "nothing fetched".
const DIAG = `(() => { window.__r33 = []; const l = document.getElementById('l');
  for (const t of ['pointerover', 'pointerdown', 'pointerup', 'mousedown', 'focus', 'blur', 'contextmenu', 'click', 'auxclick', 'touchstart'])
    l.addEventListener(t, (e) => window.__r33.push([t, e.isTrusted, e.pointerType ?? null, Date.now()]), true);
  for (const t of ['dragstart', 'dragend', 'drop'])
    document.addEventListener(t, (e) => window.__r33.push([t, e.isTrusted, e.defaultPrevented, Date.now()]), false);
  return true; })()`;

async function findView(page, layout) {
    if (layout === 'open') return page.mainFrame();
    for (let i = 0; i < 100; i++) {
        const c = page.frames().find((f) => f.parentFrame() && f.parentFrame().url().includes('/F.html') && f !== page.mainFrame());
        if (c) { try { await c.waitForSelector('#l', { state: 'attached', timeout: 5000 }); return c; } catch { /* retry */ } }
        await sleep(50);
    }
    throw new Error('view not found');
}

async function center(frame) {
    const b = await frame.locator('#l').boundingBox();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** A point in the link's document that is not on the link: 8 px into its frame's top left corner (the page's, in `open`). */
async function offLink(frame, page) {
    if (frame === page.mainFrame()) return { x: 8, y: 8 };
    const b = await (await frame.frameElement()).boundingBox();
    return { x: b.x + 8, y: b.y + 8 };
}

const XTEST = fileURLToPath(new URL('./xtest.py', import.meta.url));
const xtest = (...a) => execFileSync('python3', ['-I', XTEST, ...a.map(String)]);

/**
 * The pointer: Playwright's (page.mouse), or with `--real` the X server's (XTest, xtest.py), whose offset from the page's
 * viewport is read from where the page sees a pointer that XTest moved.
 */
async function pointer(page) {
    if (!real) return { move: (x, y, steps = 1) => page.mouse.move(x, y, { steps }), down: () => page.mouse.down(), up: () => page.mouse.up(), click: (x, y) => page.mouse.click(x, y) };
    // the point is over the host page, right of the view's frame (900 px wide), so the top document sees it
    await page.evaluate(() => { window.__r33xy = null; addEventListener('mousemove', (e) => { window.__r33xy = [e.screenX, e.screenY, e.clientX, e.clientY]; }, true); });
    let off = null;
    for (let i = 0; i < 20 && !off; i++) {
        xtest('move', 960 + i, 400 + i);
        await sleep(100);
        const xy = await page.evaluate(() => window.__r33xy);
        if (xy) off = { x: 960 + i - xy[2], y: 400 + i - xy[3] };
    }
    if (!off) throw new Error('the page saw no XTest pointer');
    let at = { x: 960, y: 400 };
    const move = async (x, y, steps = 1) => {
        for (let k = 1; k <= steps; k++) { xtest('move', at.x + ((x + off.x - at.x) * k) / steps, at.y + ((y + off.y - at.y) * k) / steps); await sleep(16); }
        at = { x: x + off.x, y: y + off.y };
    };
    return { move, down: async () => xtest('down'), up: async () => xtest('up'), click: async (x, y) => { await move(x, y, 3); xtest('down'); await sleep(60); xtest('up'); }, off };
}

async function runTrial(newContext, rec, t, trialNo) {
    const ctx = await newContext();
    const page = ctx.pages()[0] ?? await ctx.newPage();
    const popups = [];
    ctx.on('page', (p) => popups.push({ t: Date.now(), url: p.url() }));
    const consoleLines = new Set();
    page.on('console', (m) => { const s = m.text(); if (/specul|preconnect|prefetch|prerender|preload|security policy|ping|refused|blocked|sandbox/i.test(s)) consoleLines.add(s.slice(0, 200)); });
    const phases = [];
    const mark = (name) => phases.push({ name, t: Date.now() });
    const t0 = Date.now();
    const notes = {};
    const navs = [];
    page.on('framenavigated', (f) => navs.push([f === page.mainFrame() ? 'main' : 'sub', f.url().slice(0, 90), phases.at(-1)?.name ?? null]));
    mark('load');
    await page.goto(`${rec.pageOrigin}/H.html?layout=${t.layout}&case=${encodeURIComponent(t.case)}&trial=${trialNo}`, { waitUntil: 'load' });
    const view = await findView(page, t.layout);
    await view.evaluate(DIAG);
    const want = (p) => !only || only === p;
    mark('render');
    await sleep(1500);
    mark('scroll');
    await view.locator('#l').scrollIntoViewIfNeeded();
    await sleep(2500);
    let c = await center(view);
    const ptr = await pointer(page);
    if (ptr.off) notes.xtestOffset = ptr.off;
    if (want('hover')) {
        mark('hover');
        await ptr.move(c.x, c.y, 5);
        await sleep(2000);
        await ptr.move(3, 3, 3);
        await sleep(700);
    }
    if (want('tab')) {
        mark('tab');
        await page.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur());
        let focused = false;
        for (let i = 0; i < 8 && !focused; i++) {
            await page.keyboard.press('Tab');
            focused = await view.evaluate(() => document.activeElement && document.activeElement.id === 'l');
        }
        notes.tabFocused = focused;
        await sleep(1200);
        await view.evaluate(() => document.activeElement && document.activeElement.blur());
    }
    if (want('focus')) {
        mark('focus');
        notes.scriptFocused = await view.evaluate(() => { document.getElementById('l').focus(); return document.activeElement && document.activeElement.id === 'l'; });
        await sleep(1200);
        await view.evaluate(() => document.activeElement && document.activeElement.blur());
    }
    if (want('press')) {
        mark('press');
        await ptr.move(c.x, c.y);
        await ptr.down();
        await sleep(hold);
        // moved away and released inside the view's document, off the link (its top left corner): after a press released
        // outside the view, Chromium delivered no later click to the view (seen in a probe of this fixture). Moving a
        // pressed link is a drag, and its release a drop: its own phase.
        mark('drag');
        const off = await offLink(view, page);
        await ptr.move(off.x, off.y, 3);
        await ptr.up();
        await sleep(1000);
    }
    if (want('touch') && isChromium) {
        mark('touch');
        const s = await ctx.newCDPSession(page);
        await s.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
        await s.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: c.x, y: c.y }] });
        await sleep(1000);
        await s.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
        await s.send('Emulation.setTouchEmulationEnabled', { enabled: false });
        await s.detach();
        await sleep(300);
    }
    if (want('context')) {
        mark('context');
        await page.mouse.click(c.x, c.y, { button: 'right' });
        await sleep(1200);
        await page.keyboard.press('Escape');
        await sleep(300);
    }
    mark('click');
    c = await center(view);
    await ptr.click(c.x, c.y);
    await sleep(2500);
    const diag = await view.evaluate(() => window.__r33).catch(() => null);
    mark('end');
    notes.mainUrl = page.url().slice(0, 90);
    notes.navs = navs.filter((n) => !/\/(H|F)\.html|about:srcdoc/.test(n[1]));
    await ctx.close();
    await sleep(500);
    const t1 = Date.now();
    return { phases, diag, popups, notes, console: [...consoleLines], events: rec.events.filter((e) => e.t >= t0 && e.t <= t1) };
}

/** Files the recorder's events of a trial by connection, each under the phase of its first event. */
function fileHits(r, trialNo) {
    const phaseAt = (t) => { let p = 'before'; for (const x of r.phases) if (t >= x.t) p = x.name; return p; };
    // ms since the start of the phase the time falls in
    const into = (t) => { let at = t - r.phases[0].t; for (const x of r.phases) if (t >= x.t) at = t - x.t; return at; };
    const conns = new Map();
    for (const e of r.events) {
        if (e.conn === undefined) continue;
        if (!conns.has(e.conn)) conns.set(e.conn, { conn: e.conn, t: e.t, phase: phaseAt(e.t), at: into(e.t), kinds: [] });
        const c = conns.get(e.conn);
        if (e.kind === 'connect') c.target = e.target;
        if (e.kind === 'tls') c.sni = e.sni;
        if (e.kind === 'http') { c.http ??= []; c.http.push({ method: e.method, host: e.host, path: e.path, purpose: e['sec-purpose'] ?? e.purpose ?? null, dest: e['sec-fetch-dest'] ?? null, referer: e.referer ?? null, ping: e['ping-to'] ?? null, user: e['sec-fetch-user'] ?? null, phase: phaseAt(e.t), at: into(e.t) }); }
        if (e.kind === 'page') { c.page ??= []; c.page.push(e.path); }
        c.kinds.push(e.kind);
    }
    const listed = [];
    const pages = [];
    const bare = [];
    const own = listedHost(trialNo);
    for (const c of conns.values()) {
        const host = (c.target ?? c.sni ?? c.http?.[0]?.host ?? '').replace(/:\d+$/, '');
        if (host.startsWith('app.test')) { pages.push(...(c.page ?? [])); continue; }
        if (!host) { bare.push({ conn: c.conn, phase: c.phase, kinds: c.kinds.filter((k) => k !== 'close') }); continue; }
        listed.push({ phase: c.phase, at: c.at, host: host === own ? 'own' : host, connect: !!c.target, sni: c.sni ?? null, http: c.http ?? [] });
    }
    return { listed, pages: pages.filter((p) => !['/H.html', '/F.html'].includes(p)), bare };
}

const env = {};
for (const [k, v] of Object.entries(process.env)) if (!/proxy/i.test(k)) env[k] = v;
const rec = await startRecorder();
installRoutes(rec);
// How the browser reaches the recorder (`--via`):
//   direct  no proxy; the names resolve to the recorder inside the browser (Chromium: --host-resolver-rules; Firefox:
//           network.dns.forceResolve), and every listed URL carries the recorder's port. The default for Chromium and
//           Firefox: through the proxy, Firefox's speculative connections did not appear (results/*-proxy-lite).
//   proxy   the recorder is the browser's HTTP proxy (CONNECT); the default for WebKit, which has neither switch.
//   dns     (--dns) the listed site is listed.example, resolved for real by the browser (strace sees the queries);
//           app.test still reaches the recorder (Chromium: a resolver rule; Firefox: network.dns.localDomains; the page
//           origin carries the recorder's port; WebKit: the proxy, bypassed for *.listed.example).
const via = dns ? 'dns' : opt('via', config.type === webkit ? 'proxy' : 'direct');
LISTED.domain = via === 'dns' ? 'listed.example' : 'listed-r33.com';
LISTED.port = via === 'direct' ? rec.port : null;
const launch = { ...config.options, headless: !headed, env };
const extraArgs = [];
const prefs = { ...(config.options.firefoxUserPrefs ?? {}) };
if (via === 'proxy') launch.proxy = { server: rec.proxy };
if (via === 'direct' && config.type === chromium) extraArgs.push(`--host-resolver-rules=MAP app.test 127.0.0.1, MAP *.${LISTED.domain} 127.0.0.1`);
if (via === 'direct' && config.type === firefox) prefs['network.dns.forceResolve'] = '127.0.0.1';
if (via === 'dns' && config.type === chromium) extraArgs.push('--host-resolver-rules=MAP app.test 127.0.0.1');
if (via === 'dns' && config.type === firefox) prefs['network.dns.localDomains'] = 'app.test';
if (via === 'dns' && config.type === webkit) launch.proxy = { server: rec.proxy, bypass: '*.listed.example' };
if (extraArgs.length) launch.args = extraArgs;
if (config.type === firefox) launch.firefoxUserPrefs = prefs;
// Every trial runs in a browser of its own with a fresh profile on disk (launchPersistentContext). `--context` runs them
// in off-the-record contexts of one browser (newContext), Playwright's usual way: Chromium neither preconnected on a
// press nor for <link rel=preconnect> there, in this fixture's first runs, while a profile on disk did both.
const persistent = !flag('context');
const CTX = { ignoreHTTPSErrors: true, viewport: { width: 1000, height: 600 } };
const browser = persistent ? null : await config.type.launch(launch);
const profiles = [];
const newContext = persistent
    ? async () => { const d = mkdtempSync(path.join(os.tmpdir(), 'r33-profile-')); profiles.push(d); return config.type.launchPersistentContext(d, { ...launch, ...CTX }); }
    : () => browser.newContext(CTX);
let version = browser?.version();
if (persistent) { const c = await newContext(); version = c.browser()?.version() ?? null; await c.close(); }
emit('r33.run', { config: configName, note: config.note, engine: config.type.name(), version, headed, real, hold, via, only, persistent, args: extraArgs, prefs, playwright: pkgVersion, date: new Date().toISOString(), load1: load1() });
let n = Number(opt('start', 1));
for (const t of trials()) {
    const trialNo = n++;
    let r;
    try { r = await runTrial(newContext, rec, t, trialNo); } catch (e) { emit('r33.error', { config: configName, ...t, trial: trialNo, error: String(e).slice(0, 300) }); continue; }
    const filed = fileHits(r, trialNo);
    emit('r33', {
        config: configName, headed, real, via, persistent, only, layout: t.layout, case: t.case, rep: t.rep, trial: trialNo, host: listedHost(trialNo), link: linkUrl(trialNo),
        phases: r.phases.map((p) => [p.name, p.t]), ...filed, popups: r.popups.length, diag: r.diag ? r.diag.map(([k, tr, pt, at]) => [k, tr, pt, r.phases.reduce((a, p) => (at >= p.t ? p.name : a), 'before')]) : null,
        notes: r.notes, console: r.console, load1: load1(),
    });
}
await browser?.close();
for (const d of profiles) rmSync(d, { recursive: true, force: true });
await rec.close();
