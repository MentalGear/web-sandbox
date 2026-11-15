// What a browser's autofill looks like to the document it fills: every event (type, isTrusted, class, inputType, key,
// target, focused element, value, :autofill) around a fill, in the host page itself (case a), with the seeded profile
// (Seeding in the README); and which key the history uses: a field with the seeded name, a nameless field whose id is the
// seeded name, and a field whose id is the seeded name but whose name is one no page used (a name of the view's).
// Usage: R29_SCRATCH=<dir> bun probe-events.mjs --engine=chromium|firefox [--https] --forms=<names of FORMS> > <file>.json;
//        bun summarize-events.mjs <file>.json ...
import { cpSync, rmSync } from 'node:fs';
import { firefox } from 'playwright';
import { FIREFOX_PREFS } from './firefox-prefs.mjs';
import { formMarkup } from './forms.mjs';
import { HOST_ORIGIN, HTTPS_ORIGIN, PORT, startTlsFront, tlsArgs, launchChromium, pressKey, HISTORY_SEED_PAGE, seedHistory, profileDir, sleep, startServer } from './lib.mjs';

const arg = (name, fallback) => {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
};
const engine = arg('engine', 'chromium');
const tls = process.argv.includes('--https');
const ORIGIN = tls ? HTTPS_ORIGIN : HOST_ORIGIN;
const enableFeatures = arg('enable-features', '').split(',').filter(Boolean);
const forms = arg('forms', '').split(',').filter(Boolean);

const FORMS = {
    // Chromium's history: seeded under the name r29note
    'hist-name': '<form id="form"><input id="f0" name="r29note"><button id="go">Go</button></form>',
    'hist-idonly': '<form id="form"><input id="r29note"><button id="go">Go</button></form>',
    'hist-viewname': '<form id="form"><input id="r29note" name="v7f3a9c1e04b2d8_0"><button id="go">Go</button></form>',
    'hist-viewname-off': '<form id="form" autocomplete="off"><input id="r29note" name="v7f3a9c1e04b2d8_0" autocomplete="off"><button id="go">Go</button></form>',
    // Firefox's form history: seeded under email and name
    'ffhist-name': '<form id="form"><input id="f0" name="email"><button id="go">Go</button></form>',
    'ffhist-idonly': '<form id="form"><input id="email"><button id="go">Go</button></form>',
    'ffhist-viewname': '<form id="form"><input id="email" name="v7f3a9c1e04b2d8_0"><button id="go">Go</button></form>',
    address: formMarkup('address', 'ac'),
    'address-off': formMarkup('address', 'off'),
    card: formMarkup('card', 'ac'),
    login: formMarkup('login', 'ac'),
};
const FIRST = { address: 'name', 'address-off': 'name', card: 'ccname', login: 'u' };

const REPORTER = `
window.__log = [];
const TYPES = ['pointerdown','pointerup','click','keydown','keyup','keypress','beforeinput','input','change','focusin','focusout','compositionstart','textInput','select'];
const af = (t) => { try { return t.matches(':autofill'); } catch { try { return t.matches(':-moz-autofill'); } catch { return null; } } };
for (const type of TYPES) addEventListener(type, (e) => {
  const t = e.target;
  window.__log.push({ step: window.__step, type, trusted: e.isTrusted, cls: e.constructor.name, inputType: e.inputType, key: e.key, data: e.data, target: t && t.id, active: document.activeElement && document.activeElement.id, value: t && typeof t.value === 'string' ? t.value : undefined, af: t && t.matches ? af(t) : null });
}, true);
document.addEventListener('submit', (e) => e.preventDefault(), true);
window.__state = () => [...document.querySelectorAll('input')].map((i) => i.id + '=' + JSON.stringify(i.value) + (af(i) ? '*' : '')).join(' ');
`;
const srv = await startServer(PORT);
srv.route('/f', (req, url) => ({ body: `<!doctype html><meta charset=utf-8><title>r29fix</title><body><script>window.__step='load';${REPORTER}</script>${FORMS[url.searchParams.get('form')]}</body>` }));
srv.route('/submitted', { body: 'submitted' });
srv.route('/history-seed', { body: HISTORY_SEED_PAGE });

const dir = profileDir(`run-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
cpSync(profileDir(`${engine}-profile`), dir, { recursive: true });
const front = tls ? await startTlsFront() : null;
const ctx = engine === 'firefox'
    ? await firefox.launchPersistentContext(dir, { headless: true, firefoxUserPrefs: FIREFOX_PREFS, viewport: { width: 1100, height: 900 } })
    : await launchChromium(dir, { headless: true, enableFeatures, args: tls ? tlsArgs() : [] });
const p = ctx.pages()[0] ?? (await ctx.newPage());
const cdp = engine === 'chromium' ? await ctx.newCDPSession(p) : null;
const evalTop = async (expression) => (cdp ? (await cdp.send('Runtime.evaluate', { expression, returnByValue: true, userGesture: false })).result.value : p.evaluate(expression));
const press = (key) => (cdp ? pressKey(cdp, key) : p.keyboard.press(key));
if (engine === 'chromium' && forms.some((f) => f.startsWith('hist'))) await seedHistory(p, ORIGIN);
const out = { engine, version: ctx.browser()?.version(), origin: ORIGIN, enableFeatures, cases: [] };
for (const form of forms) {
    await p.goto(`${ORIGIN}/f?form=${form}`);
    await sleep(2000);
    const loadState = await evalTop('window.__state()');
    await evalTop("window.__step='click'");
    const first = FIRST[form] ?? (form.includes('idonly') || form.includes('viewname') ? (form.startsWith('ff') ? 'email' : 'r29note') : 'f0');
    await p.locator(`#${first}`).click();
    await sleep(1200);
    await evalTop("window.__step='arrow'");
    if (!cdp) { await press('ArrowDown'); await sleep(700); }
    await press('ArrowDown');
    await sleep(900);
    const arrowState = await evalTop('window.__state()');
    await evalTop("window.__step='enter'");
    await press('Enter');
    await sleep(1500);
    const endState = await evalTop('window.__state()');
    const log = await evalTop('JSON.stringify(window.__log)');
    out.cases.push({ form, loadState, arrowState, endState, log: JSON.parse(log) });
}
console.log(JSON.stringify(out));
await ctx.close();
await srv.close();
await front?.close();
rmSync(dir, { recursive: true, force: true });
