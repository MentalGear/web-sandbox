// Cases a to d of research 29, no library: the probe forms in the host page itself (a), in today's topology without the
// library (b: iframe sandbox="allow-scripts" srcdoc), in the planned served topology (c: a served same-origin file
// framed with sandbox="allow-scripts", the form in the file; cc: in the file's own sandboxed srcdoc child) and in the
// same file framed without sandbox (d); `bshadow`, `cshadow`, `ccshadow`, `dshadow`: the same frames in an open shadow
// root, as the element holds its frame; the rest are the diagnosis of case e (one property of the library's view each,
// added to b). One page load per case, form kind and variant; on each, the user-like sequence:
// load, a click in the first field, ArrowDown, Enter, Tab through the fields. After each step it records what script
// in the form's document reads (value and :autofill per field), and the reporter's event log.
//
// Usage: R29_SCRATCH=<dir> bun run-plain.mjs [--headed] [--allow=<allow attribute>] [--cases=a,b,c,cc,d]
//        [--kinds=login,address,card] [--variants=ac,noac,...] [--shots=<dir>] [--profile=<seeded profile name>]
//        [--engine=chromium|firefox] [--https] [--disable-features=...] [--enable-features=...] [--internals]
//        [--seed-history] [--serve-only]
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { firefox } from 'playwright';
import { FIREFOX_PREFS } from './firefox-prefs.mjs';
import { FIELDS, VARIANTS, fieldId, formMarkup, reporterScript } from './forms.mjs';
import { HOST_ORIGIN, HTTPS_ORIGIN, PORT, startTlsFront, tlsArgs, SEEDED_STRINGS, emit, launchChromium, pressKey, HISTORY_SEED_PAGE, seedHistory, profileDir, sleep, startServer } from './lib.mjs';

const arg = (name, fallback) => {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
};
const headed = process.argv.includes('--headed');
const tls = process.argv.includes('--https');
const ORIGIN = tls ? HTTPS_ORIGIN : HOST_ORIGIN;
const allow = arg('allow', '');
const cases = arg('cases', 'a,b,c,cc,d').split(',');
const kinds = arg('kinds', 'login,address,card').split(',');
const variants = arg('variants', VARIANTS.join(',')).split(',');
const shots = arg('shots', '');
const engine = arg('engine', 'chromium');
const seeded = arg('profile', `${engine}-profile`);
if (shots) mkdirSync(shots, { recursive: true });

const esc = (s) => s.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
const page = (body) => `<!doctype html><meta charset="utf-8"><title>r29</title><body>${body}</body>`;
const formDoc = (label, kind, variant) => page(`${formMarkup(kind, variant)}<script>${reporterScript(label)}</script>`);
// The form inserted by script after load, the way the view's renderer inserts a render: parsed in an inert <template>,
// then its content appended to the body (the reporter listens on the document, so it sees the inserted fields).
const dynamicDoc = (label, kind, variant) => page(`<script>${reporterScript(label)}
addEventListener('load', () => setTimeout(() => {
  const t = document.createElement('template');
  t.innerHTML = ${JSON.stringify(formMarkup(kind, variant)).replaceAll('<', '\\u003c')};
  document.body.append(t.content);
}, 300));</script>`);
const frameAttrs = (sandboxed) => `${sandboxed ? ' sandbox="allow-scripts"' : ''}${allow ? ` allow="${esc(allow)}"` : ''} width="700" height="520"`;

const srv = await startServer(PORT);
// The host page keeps every report, and asks every document for a snap with __snap(step). __snap is called through a
// CDP Runtime.evaluate with userGesture false: Playwright's own evaluate runs with a user gesture, which would hand the
// page the activation that Chromium waits for before it lets script read an autofilled password.
const hostCollector = `<script>
window.__r29log = [];
addEventListener('message', (e) => { if (e.data && e.data.r29) window.__r29log.push(e.data); });
window.__snap = (step) => {
  if (document.querySelector('input')) postMessage({ r29snap: step }, '*');
  for (let i = 0; i < frames.length; i++) frames[i].postMessage({ r29snap: step }, '*');
  // window.frames lists only the frames of the document's own tree: a frame in a shadow root is reached by its element
  for (const host of document.querySelectorAll('#shadowhost')) for (const f of host.shadowRoot.querySelectorAll('iframe')) f.contentWindow.postMessage({ r29snap: step }, '*');
};
</script>`;
srv.route('/host', (req, url) => {
    const kind = url.searchParams.get('kind');
    const variant = url.searchParams.get('variant');
    const c = url.searchParams.get('case');
    const q = `kind=${kind}&variant=${variant}`;
    if (c === 'a') return { body: page(`${hostCollector}${formMarkup(kind, variant)}<script>${reporterScript('a')}</script>`) };
    if (c === 'b') return { body: page(`${hostCollector}<iframe${frameAttrs(true)} srcdoc="${esc(formDoc('b', kind, variant))}"></iframe>`) };
    if (c === 'c') return { body: page(`${hostCollector}<iframe${frameAttrs(true)} src="/served?${q}&where=self&label=c"></iframe>`) };
    if (c === 'cc') return { body: page(`${hostCollector}<iframe${frameAttrs(true)} src="/served?${q}&where=child&label=cc"></iframe>`) };
    // Diagnostics: today's topology with one property of the library's view each (its sandbox flags, its policy).
    const withHead = (head) => `<!doctype html><meta charset="utf-8">${head}<title>r29</title><body>${formMarkup(kind, variant)}<script>${reporterScript(c)}</script></body>`;
    if (c === 'bforms') return { body: page(`${hostCollector}<iframe sandbox="allow-scripts allow-forms" width="700" height="520" srcdoc="${esc(formDoc(c, kind, variant))}"></iframe>`) };
    if (c === 'bfa') return { body: page(`${hostCollector}<iframe${frameAttrs(true)} srcdoc="${esc(withHead(`<meta http-equiv="Content-Security-Policy" content="form-action 'none'">`))}"></iframe>`) };
    if (c === 'bdef') return { body: page(`${hostCollector}<iframe${frameAttrs(true)} srcdoc="${esc(withHead(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'">`))}"></iframe>`) };
    if (c === 'blayer') return { body: page(`${hostCollector}<iframe${frameAttrs(true)} srcdoc="${esc(withHead('<style>@layer{*{animation:none!important;transition:none!important}}</style>'))}"></iframe>`) };
    if (c === 'afa') return { body: `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="form-action 'none'"><title>r29</title><body>${hostCollector}${formMarkup(kind, variant)}<script>${reporterScript(c)}</script></body>` };
    if (c === 'bbase') return { body: page(`${hostCollector}<iframe${frameAttrs(true)} srcdoc="${esc(withHead('<base href="about:blank">'))}"></iframe>`) };
    if (c === 'w2base') {
        const child = `<iframe sandbox="allow-scripts" width="680" height="500" srcdoc="${esc(formDoc('w2base', kind, variant))}"></iframe>`;
        const relay = `<script>addEventListener('message', (e) => { if (e.data && e.data.r29snap) for (let i = 0; i < frames.length; i++) frames[i].postMessage(e.data, '*'); });</script>`;
        return { body: page(`${hostCollector}<iframe${frameAttrs(true)} srcdoc="${esc(`<!doctype html><meta charset="utf-8"><base href="about:blank"><title>w</title><body>${child}${relay}</body>`)}"></iframe>`) };
    }
    // The frame inside an open shadow root, as the library's element holds its frame (src/host.ts attachShadow).
    const inShadow = (frameHtml) => `${hostCollector}<div id="shadowhost"></div><script>document.getElementById('shadowhost').attachShadow({ mode: 'open' }).innerHTML = ${JSON.stringify(frameHtml).replaceAll('<', '\\u003c')};</script>`;
    if (c === 'bshadow') return { body: page(inShadow(`<iframe${frameAttrs(true)} srcdoc="${esc(formDoc(c, kind, variant))}"></iframe>`)) };
    if (c === 'cshadow') return { body: page(inShadow(`<iframe${frameAttrs(true)} src="/served?${q}&where=self&label=cshadow"></iframe>`)) };
    if (c === 'ccshadow') return { body: page(inShadow(`<iframe${frameAttrs(true)} src="/served?${q}&where=child&label=ccshadow"></iframe>`)) };
    if (c === 'dshadow') return { body: page(inShadow(`<iframe${frameAttrs(false)} src="/served?${q}&where=self&label=dshadow"></iframe>`)) };
    if (c === 'w2shadow') {
        const child = `<iframe sandbox="allow-scripts" width="680" height="500" srcdoc="${esc(formDoc(c, kind, variant))}"></iframe>`;
        const relay = `<script>addEventListener('message', (e) => { if (e.data && e.data.r29snap) for (let i = 0; i < frames.length; i++) frames[i].postMessage(e.data, '*'); });</script>`;
        return { body: page(inShadow(`<iframe${frameAttrs(true)} srcdoc="${esc(page(child + relay))}"></iframe>`)) };
    }
    if (c === 'bdyn') return { body: page(`${hostCollector}<iframe${frameAttrs(true)} srcdoc="${esc(dynamicDoc('bdyn', kind, variant))}"></iframe>`) };
    if (c === 'w2') {
        const child = `<iframe sandbox="allow-scripts" width="680" height="500" srcdoc="${esc(formDoc('w2', kind, variant))}"></iframe>`;
        const relay = `<script>addEventListener('message', (e) => { if (e.data && e.data.r29snap) for (let i = 0; i < frames.length; i++) frames[i].postMessage(e.data, '*'); });</script>`;
        return { body: page(`${hostCollector}<iframe${frameAttrs(true)} srcdoc="${esc(page(child + relay))}"></iframe>`) };
    }
    if (c === 'd') return { body: page(`${hostCollector}<iframe${frameAttrs(false)} src="/served?${q}&where=self&label=d"></iframe>`) };
    return { status: 404, body: 'no case' };
});
srv.route('/served', (req, url) => {
    const kind = url.searchParams.get('kind');
    const variant = url.searchParams.get('variant');
    const label = url.searchParams.get('label');
    if (url.searchParams.get('where') === 'self') return { body: formDoc(label, kind, variant) };
    const relay = `<script>addEventListener('message', (e) => { if (e.data && e.data.r29snap) for (let i = 0; i < frames.length; i++) frames[i].postMessage(e.data, '*'); });</script>`;
    return { body: page(`<iframe sandbox="allow-scripts"${allow ? ` allow="${esc(allow)}"` : ''} width="680" height="500" srcdoc="${esc(formDoc(label, kind, variant))}"></iframe>${relay}`) };
});
srv.route('/submitted', { body: page('submitted') });
srv.route('/history-seed', { body: HISTORY_SEED_PAGE });

// Each run starts from a copy of the seeded profile, so a fill in one run (use counts, a saved form entry) never seeds
// the next.
// --serve-only: no browser; the routes stay up on loopback for a person to open in a browser Playwright cannot drive
// (the Safari checklist of the README). Stop it with Ctrl-C.
if (process.argv.includes('--serve-only')) {
    console.log(`serving ${HOST_ORIGIN}/host?case=a&kind=address&variant=ac (and the other cases' URLs); Ctrl-C stops`);
    await new Promise(() => {});
}

const dir = profileDir(`run-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
cpSync(profileDir(seeded), dir, { recursive: true });
const disableFeatures = arg('disable-features', '').split(',').filter(Boolean);
const enableFeatures = arg('enable-features', '').split(',').filter(Boolean);
const front = tls ? await startTlsFront() : null;
const ctx = engine === 'firefox'
    ? await firefox.launchPersistentContext(dir, { headless: !headed, firefoxUserPrefs: FIREFOX_PREFS, viewport: { width: 1100, height: 900 } })
    : await launchChromium(dir, { headless: !headed, disableFeatures, enableFeatures, args: tls ? tlsArgs() : [] });
emit('plain.run', { engine, version: ctx.browser()?.version(), headless: !headed, origin: ORIGIN, disableFeatures, enableFeatures, allow, date: new Date().toISOString() });

/** The frame whose document has the form, by depth (no evaluate in it: see hostCollector). */
const DEPTH = { a: 0, afa: 0, b: 1, bdyn: 1, bforms: 1, bfa: 1, bdef: 1, blayer: 1, c: 1, cc: 2, w2: 2, w2base: 2, bbase: 1, bshadow: 1, cshadow: 1, ccshadow: 2, dshadow: 1, w2shadow: 2, d: 1 };
async function formFrame(p, c) {
    for (let tries = 0; tries < 50; tries++) {
        const frames = p.frames();
        for (const f of frames) {
            let depth = 0;
            for (let up = f.parentFrame(); up; up = up.parentFrame()) depth++;
            if (depth === DEPTH[c] && (depth === 0 || f.url() !== '')) return f;
        }
        await sleep(100);
    }
    throw new Error('no form frame');
}

/**
 * An expression evaluated in the host page (top), never in the form's frame. On Chromium through CDP with userGesture
 * false (see hostCollector); on Firefox through Playwright, whose evaluate in top hands the form's frame no activation
 * (activation goes to a frame and its ancestors, never down).
 */
async function evalTop(p, cdp, expression) {
    if (!cdp) return p.evaluate(expression);
    return (await cdp.send('Runtime.evaluate', { expression, returnByValue: true, userGesture: false })).result.value;
}

/** A key as a real keyboard sends it (pressKey, on Chromium) or as Playwright's keyboard does (Firefox). */
const press = (p, cdp, key) => (cdp ? pressKey(cdp, key) : p.keyboard.press(key));

/** What script in the form's document read at this step (its reporter's answer to a snap, without a gesture). */
async function read(p, cdp, step) {
    await evalTop(p, cdp, `window.__snap(${JSON.stringify(step)})`);
    for (let tries = 0; tries < 30; tries++) {
        const fields = JSON.parse(await evalTop(p, cdp,
            `JSON.stringify((window.__r29log.filter((m) => m.what === 'snap' && m.step === ${JSON.stringify(step)}).pop() || {}).fields || null)`));
        if (fields) return fields;
        await sleep(50);
    }
    return [];
}

const leaked = (fields) => {
    const out = [];
    for (const f of fields) for (const s of SEEDED_STRINGS) if (f.value.includes(s)) { out.push(f.id); break; }
    return out;
};
const compact = (fields) => fields.map((f) => `${f.id}=${JSON.stringify(f.value)}${f.autofill ? '*' : ''}`).join(' ');

// --internals: chrome://autofill-internals open in a second tab; its "Abort" lines and the forms' URLs are printed per case
const internals = process.argv.includes('--internals') ? await ctx.newPage() : null;
if (internals) await internals.goto('chrome://autofill-internals');
const p = ctx.pages()[0] ?? (await ctx.newPage());
if (internals) await p.bringToFront();
const cdp = engine === 'chromium' ? await ctx.newCDPSession(p) : null;
if (process.argv.includes('--seed-history')) await seedHistory(p, ORIGIN);
for (const c of cases) {
    for (const kind of kinds) {
        for (const variant of variants) {
            await p.goto(`${ORIGIN}/host?case=${c}&kind=${kind}&variant=${variant}`);
            const frame = await formFrame(p, c);
            const steps = {};
            await sleep(2000);
            steps.load = await read(p, cdp, 'load');
            await frame.locator(`#${fieldId(kind, variant, 0)}`).click();
            await sleep(1200);
            steps.focus = await read(p, cdp, 'focus');
            // Firefox opens its popup on the first ArrowDown and selects the first entry on the second; Chromium's popup is
            // open after the click
            if (!cdp) {
                await press(p, cdp, 'ArrowDown');
                await sleep(700);
            }
            await press(p, cdp, 'ArrowDown');
            await sleep(900);
            steps.arrow = await read(p, cdp, 'arrow');
            if (shots) await p.screenshot({ path: `${shots}/${c}-${kind}-${variant}${allow ? '-allow' : ''}-arrow.png` });
            await press(p, cdp, 'Enter');
            await sleep(1500);
            steps.chosen = await read(p, cdp, 'chosen');
            for (let i = 1; i < FIELDS[kind].length; i++) {
                await press(p, cdp, 'Tab');
                await sleep(150);
            }
            await sleep(500);
            steps.tab = await read(p, cdp, 'tab');
            if (shots) await p.screenshot({ path: `${shots}/${c}-${kind}-${variant}${allow ? '-allow' : ''}-end.png` });
            const log = JSON.parse(await evalTop(p, cdp, 'JSON.stringify(window.__r29log)'));
            const trustedInputs = log.filter((m) => m.what === 'event' && (m.type === 'input' || m.type === 'change') && m.trusted);
            const result = { case: c, kind, variant, allow, frameUrl: frame.url().slice(0, 60) };
            for (const [step, fields] of Object.entries(steps)) result[step] = { leaked: leaked(fields), fields: compact(fields) };
            result.events = {
                trustedInputOrChange: trustedInputs.length,
                withSeededValue: trustedInputs.filter((m) => leaked(m.fields).length > 0).length,
                first: (() => { const m = log.find((x) => leaked(x.fields).length > 0); return m ? `${m.what}:${m.type ?? m.step}:${m.trusted ?? ''}:${m.target ?? ''}` : null; })(),
            };
            if (internals) {
                const text = await internals.locator('body').innerText();
                const lines = text.split('\n').filter((l) => /^(Abort|URL:|Action:|Origin:)/.test(l));
                result.internals = [...new Set(lines)].slice(0, 20);
                await internals.reload();
            }
            emit('plain.case', result);
        }
    }
}
await ctx.close();
await srv.close();
await front?.close();
rmSync(dir, { recursive: true, force: true });
