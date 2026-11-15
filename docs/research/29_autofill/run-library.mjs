// Case e of research 29: the library itself. A host page on the origin the profile has saved data for embeds
// <web-sandbox> in sealed mode at its default configuration (only `entry` and `html`, as examples/sealed-app does); the
// guest's `html` is the probe form, rendered by the view's renderer, and the guest's worker subscribes to every event
// type sandboxView.on offers on the form and reports each detail it receives to the host through bridge.call. The user-
// like sequence is run-plain.mjs's: load, a click in the first field, ArrowDown, Enter, Tab through the fields, then a
// click on Submit. The bundle is the default build, built outside the repository:
//   bun scripts/build-lib.ts --out <scratch>/dist
// Usage: R29_SCRATCH=<dir> bun run-library.mjs [--headed] [--kinds=...] [--variants=...] [--shots=<dir>]
//        [--disable-features=...] [--enable-features=...] [--dist=<dir with index.js>] [--https] [--debug] [--internals]
//        [--engine=chromium|firefox] [--seed-history] [--serve-only]
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { firefox } from 'playwright';
import { FIREFOX_PREFS } from './firefox-prefs.mjs';
import { FIELDS, VARIANTS, fieldId, formMarkup } from './forms.mjs';
import { HOST_ORIGIN, HTTPS_ORIGIN, PORT, startTlsFront, tlsArgs, SEEDED_STRINGS, emit, launchChromium, pressKey, HISTORY_SEED_PAGE, seedHistory, profileDir, sleep, startServer } from './lib.mjs';

const arg = (name, fallback) => {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
};
const headed = process.argv.includes('--headed');
const engine = arg('engine', 'chromium');
const tls = process.argv.includes('--https');
const ORIGIN = tls ? HTTPS_ORIGIN : HOST_ORIGIN;
const kinds = arg('kinds', 'login,address,card').split(',');
const variants = arg('variants', VARIANTS.join(',')).split(',');
const shots = arg('shots', '');
const dist = arg('dist', `${process.env.R29_SCRATCH}/dist`);
const disableFeatures = arg('disable-features', '').split(',').filter(Boolean);
const enableFeatures = arg('enable-features', '').split(',').filter(Boolean);
if (shots) mkdirSync(shots, { recursive: true });

// The guest: every event type of sandboxView.on, on the form (its handler receives the events of the form's fields,
// whose ids are in `event.ids`), each detail reported to the host as it came.
const GUEST = `
const TYPES = ['input', 'change', 'submit', 'keydown', 'focusin', 'focusout', 'click'];
for (const type of TYPES) sandboxView.on(type, 'form', (event) => { bridge.call('report', event).catch(() => {}); });
bridge.call('report', { type: 'ready' }).catch(() => {});
`;

const srv = await startServer(PORT);
srv.route('/dist/index.js', { headers: { 'content-type': 'text/javascript; charset=utf-8' }, body: readFileSync(`${dist}/index.js`, 'utf8') });
srv.route('/submitted', { body: 'submitted' });
srv.route('/history-seed', { body: HISTORY_SEED_PAGE });
srv.route('/lib-host', (req, url) => {
    const kind = url.searchParams.get('kind');
    const variant = url.searchParams.get('variant');
    return {
        body: `<!doctype html><meta charset="utf-8"><title>r29 e</title><body><p>host page</p><div id="box" style="width:720px;height:560px"></div>
<script type="module">
import { defineWebSandbox } from '/dist/index.js';
defineWebSandbox();
window.__guestLog = [];
window.__step = 'load';
const sandbox = document.createElement('web-sandbox');
sandbox.style.cssText = 'display:block;width:700px;height:540px';
document.getElementById('box').append(sandbox);
sandbox.addEventListener('sandbox-error', (e) => window.__guestLog.push({ step: window.__step, hostEvent: 'sandbox-error', detail: String(e.detail && (e.detail.reason || e.detail.message)) }));
sandbox.registerFiles({ 'app.js': ${JSON.stringify(GUEST)} });
sandbox.expose('report', (detail) => { window.__guestLog.push({ step: window.__step, detail }); });
sandbox.setConfig({ entry: 'app.js', html: ${JSON.stringify(formMarkup(kind, variant))} });
</script></body>`,
    };
});

// --serve-only: no browser; the routes stay up on loopback for a person to open in a browser Playwright cannot drive
// (the Safari checklist of the README). Stop it with Ctrl-C.
if (process.argv.includes('--serve-only')) {
    console.log(`serving ${HOST_ORIGIN}/lib-host?kind=address&variant=ac (and the other cases' URLs); Ctrl-C stops`);
    await new Promise(() => {});
}

const dir = profileDir(`run-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
cpSync(profileDir(`${engine}-profile`), dir, { recursive: true });
const front = tls ? await startTlsFront() : null;
const ctx = engine === 'firefox'
    ? await firefox.launchPersistentContext(dir, { headless: !headed, firefoxUserPrefs: FIREFOX_PREFS, viewport: { width: 1100, height: 900 } })
    : await launchChromium(dir, { headless: !headed, disableFeatures, enableFeatures, args: tls ? tlsArgs() : [] });
emit('lib.run', { engine, version: ctx.browser()?.version(), headless: !headed, origin: ORIGIN, disableFeatures, enableFeatures, date: new Date().toISOString() });
const internals = process.argv.includes('--internals') && engine === 'chromium' ? await ctx.newPage() : null;
if (internals) await internals.goto('chrome://autofill-internals');
const p = ctx.pages()[0] ?? (await ctx.newPage());
if (internals) await p.bringToFront();
const cdp = engine === 'chromium' ? await ctx.newCDPSession(p) : null;
// No Playwright evaluate on the page before the user's gesture (Playwright's evaluate carries one): CDP, userGesture false.
// On Firefox, Playwright's evaluate in top (activation reaches a frame and its ancestors, never the view below it).
const hostEval = async (expression) => {
    if (!cdp) return p.evaluate(expression);
    return (await cdp.send('Runtime.evaluate', { expression, returnByValue: true, userGesture: false })).result.value;
};
const press = (key) => (cdp ? pressKey(cdp, key) : p.keyboard.press(key));
const mark = (step) => hostEval(`window.__step = ${JSON.stringify(step)}`);

/** The view's frame: the deepest frame (the view document holds the rendered form). */
async function viewFrame() {
    for (let tries = 0; tries < 100; tries++) {
        let best = null;
        let bestDepth = -1;
        for (const f of p.frames()) {
            let depth = 0;
            for (let up = f.parentFrame(); up; up = up.parentFrame()) depth++;
            if (depth > bestDepth) { best = f; bestDepth = depth; }
        }
        const ready = await hostEval('window.__guestLog && window.__guestLog.some((m) => m.detail && m.detail.type === "ready")');
        // no locator here: Playwright's queries run with a user gesture, which would activate the view's frame early
        if (bestDepth > 0 && ready) return { frame: best, depth: bestDepth };
        await sleep(100);
    }
    throw new Error('no view frame');
}

const seededIn = (text) => {
    const out = [];
    for (const s of SEEDED_STRINGS) if (text.includes(s)) out.push(s);
    return out;
};

if (process.argv.includes('--seed-history')) await seedHistory(p, ORIGIN);
for (const kind of kinds) {
    for (const variant of variants) {
        await p.goto(`${ORIGIN}/lib-host?kind=${kind}&variant=${variant}`);
        const { frame, depth } = await viewFrame();
        await mark('load');
        await sleep(2000);
        await mark('focus');
        await frame.locator(`#${fieldId(kind, variant, 0)}`).click();
        await sleep(1200);
        await mark('arrow');
        // Firefox opens its popup on the first ArrowDown and selects the first entry on the second
        if (!cdp) {
            await press('ArrowDown');
            await sleep(700);
        }
        await press('ArrowDown');
        await sleep(900);
        if (shots) await p.screenshot({ path: `${shots}/e-${kind}-${variant}-arrow.png` });
        await mark('chosen');
        await press('Enter');
        await sleep(1500);
        await mark('tab');
        for (let i = 1; i < FIELDS[kind].length; i++) {
            await press('Tab');
            await sleep(150);
        }
        await sleep(500);
        if (shots) await p.screenshot({ path: `${shots}/e-${kind}-${variant}-end.png` });
        await mark('submit');
        await frame.locator('#go').click();
        await sleep(1000);
        const log = JSON.parse(await hostEval('JSON.stringify(window.__guestLog)'));
        // what the view's own document shows now (the view's script reads the same values when it describes an event)
        const renderedAttrs = await frame.locator('input').evaluateAll((els) => els.map((e) => [...e.attributes].map((a) => `${a.name}=${a.value}`).join(' ')));
        const shown = await frame.locator('input').evaluateAll((els) => els.map((e) => `${e.id}=${JSON.stringify(e.value)}${(() => { try { return e.matches(':autofill'); } catch { return e.matches(':-moz-autofill'); } })() ? '*' : ''}`).join(' '));
        if (process.argv.includes('--debug')) {
            for (const f of p.frames()) {
                const info = await f.evaluate(() => ({
                    url: location.href.slice(0, 60), origin: self.origin,
                    head: document.head ? document.head.outerHTML.slice(0, 700) : null,
                    frames: [...document.querySelectorAll('iframe')].map((i) => [...i.attributes].filter((a) => a.name !== 'srcdoc').map((a) => `${a.name}=${a.value.slice(0, 80)}`).join(' ')),
                    bodyAttrs: document.body ? [...document.body.attributes].map((a) => `${a.name}=${a.value.slice(0, 80)}`).join(' ') : null,
                    htmlAttrs: [...document.documentElement.attributes].map((a) => `${a.name}=${a.value.slice(0, 80)}`).join(' '),
                    formParent: document.querySelector('form') ? document.querySelector('form').parentElement.outerHTML.slice(0, 300) : null,
                })).catch((e) => String(e).slice(0, 200));
                emit('lib.debug.frame', info);
            }
        }
        const byStep = {};
        for (const m of log) {
            if (!m.detail || m.detail.type === 'ready') continue;
            const text = JSON.stringify(m.detail);
            const hits = seededIn(text);
            const row = (byStep[m.step] ??= { events: 0, withSeeded: 0, types: {}, seeded: [] });
            row.events++;
            row.types[m.detail.type] = (row.types[m.detail.type] ?? 0) + 1;
            if (hits.length) {
                row.withSeeded++;
                for (const h of hits) if (!row.seeded.includes(h)) row.seeded.push(h);
            }
        }
        const firstLeak = log.find((m) => m.detail && seededIn(JSON.stringify(m.detail)).length > 0);
        emit('lib.case', {
            case: 'e', kind, variant, viewDepth: depth, renderedAttrs, byStep, shownAtEnd: shown,
            firstLeak: firstLeak ? { step: firstLeak.step, type: firstLeak.detail.type, target: firstLeak.detail.target } : null,
            hostErrors: log.filter((m) => m.hostEvent).map((m) => m.detail),
        });
    }
}
if (internals) emit('lib.internals', (await internals.locator('body').innerText()).slice(-30000));
await ctx.close();
await srv.close();
await front?.close();
rmSync(dir, { recursive: true, force: true });
