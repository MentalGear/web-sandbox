// The editing matrix of the view's value model: for each way a user (or a script) changes a control's value, what the
// document sees: every event's type, isTrusted, class, inputType, target, the focused element, the target's value and
// whether it matches :autofill. Plain Playwright, no profile, on any engine.
// Usage: bun probe-editing.mjs <chromium|firefox|webkit> [frame] > <file>.json; bun summarize-editing.mjs <file>.json ...
// `frame`: the controls in an opaque sandboxed srcdoc frame inside a shadow root, as the library's view.
import { chromium, firefox, webkit } from 'playwright';

const engine = process.argv[2] ?? 'chromium';
const inFrame = process.argv[3] === 'frame';
const launcher = { chromium, firefox, webkit }[engine];
const browser = await launcher.launch();
const ctx = await browser.newContext({ viewport: { width: 900, height: 700 } });
if (engine === 'chromium') await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);

const FORM = `<p id="src" style="font:20px monospace">dragword other</p>
<input id="a" name="fa" style="width:200px"> <input id="b" name="fb" style="width:200px"><br>
<textarea id="t"></textarea><br>
<label id="lc">C <input type=checkbox id="c"></label> <input type=radio name=r id="r1"><input type=radio name=r id="r2"><br>
<select id="s"><option>one<option>two<option>three</select>
<input type=range id="rg" style="width:200px"> <input type=color id="col"> <input type=date id="d"><br>
<form id="f"><input id="fx" name="x" value="def"><button type=reset id="rs">reset</button></form>`;
const REPORTER = `
window.__log = [];
const TYPES = ['pointerdown','click','keydown','beforeinput','input','change','focusin','dragstart','drop','compositionstart','compositionend','paste','cut','reset'];
for (const type of TYPES) addEventListener(type, (e) => {
  const t = e.target; let af = null; try { af = t.matches && t.matches(':autofill'); } catch { try { af = t.matches(':-moz-autofill'); } catch {} }
  window.__log.push({ type, trusted: e.isTrusted, inputType: e.inputType, cls: e.constructor.name, target: t && t.id, active: document.activeElement && document.activeElement.id, value: t && 'value' in t ? (t.type === 'checkbox' || t.type === 'radio' ? String(t.checked) : t.value) : undefined, af });
}, true);`;
const DOC = `<!doctype html><meta charset=utf-8><body>${FORM}<script>${REPORTER}</script></body>`;
const p = await ctx.newPage();
if (inFrame) {
    await p.setContent(`<!doctype html><body><div id=h></div><script>document.getElementById('h').attachShadow({mode:'open'}).innerHTML = '<iframe sandbox="allow-scripts" width=880 height=600 style="border:0"></iframe>'; document.getElementById('h').shadowRoot.querySelector('iframe').srcdoc = ${JSON.stringify(DOC).replaceAll("<", "\\u003c")};</script></body>`);
    await p.waitForTimeout(500);
} else await p.setContent(DOC);
let f = p.mainFrame();
for (let i = 0; inFrame && i < 100; i++) {
    const found = p.frames().find((fr) => fr !== p.mainFrame());
    if (found && (await found.locator('#fx').count().catch(() => 0)) > 0) { f = found; break; }
    await p.waitForTimeout(100);
}
await f.waitForSelector('#fx');
const mod = engine === 'webkit' && process.platform === 'darwin' ? 'Meta' : 'Control';
const box = async (sel) => { const b = await f.locator(sel).boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, b }; };
const out = [];
async function way(name, run) {
    await f.evaluate(() => { window.__log = []; });
    let error = null;
    try { await run(); } catch (e) { error = String(e).slice(0, 160); }
    await p.waitForTimeout(250);
    const log = await f.evaluate(() => window.__log);
    out.push({ name, error, log });
}
const cdp = engine === 'chromium' ? await ctx.newCDPSession(p) : null;

await way('type', async () => { await f.locator('#a').click(); await p.keyboard.type('ab'); });
await way('backspace', async () => { await p.keyboard.press('Backspace'); });
await way('delete', async () => { await p.keyboard.press('Home'); await p.keyboard.press('Delete'); });
await way('type more', async () => { await p.keyboard.type('xyz'); });
await way('copy(no change)', async () => { await p.keyboard.press(`${mod}+A`); await p.keyboard.press(`${mod}+C`); });
await way('paste keyboard', async () => { await f.locator('#b').click(); await p.keyboard.press(`${mod}+V`); });
await way('cut', async () => { await p.keyboard.press(`${mod}+A`); await p.keyboard.press(`${mod}+X`); });
await way('undo', async () => { await p.keyboard.press(`${mod}+Z`); });
await way('redo', async () => { await p.keyboard.press(`${mod}+Shift+Z`); });
await way('redo ctrl+y', async () => { await p.keyboard.press(`${mod}+Z`); await p.keyboard.press(`${mod}+Y`); });
await way('insertText (IME commit)', async () => { await f.locator('#a').click(); await p.keyboard.press('End'); await p.keyboard.insertText('é'); });
if (cdp) await way('CDP imeSetComposition + insertText', async () => {
    await cdp.send('Input.imeSetComposition', { text: 'に', selectionStart: 1, selectionEnd: 1 });
    await cdp.send('Input.imeSetComposition', { text: 'にほ', selectionStart: 2, selectionEnd: 2 });
    await cdp.send('Input.insertText', { text: '日本' });
});
// drag a word of #src into a field: once into the focused field (#a), once into another (#b) while #a is focused
for (const [label, target] of [['drop into focused #a', '#a'], ['drop into unfocused #b', '#b']]) {
    await way(label, async () => {
        await f.locator('#a').click();
        await f.locator('#src').dblclick({ position: { x: 20, y: 10 } });
        const s = await box('#src');
        const t = await box(target);
        await p.mouse.move(s.b.x + 20, s.b.y + 10);
        await p.mouse.down();
        await p.mouse.move(s.b.x + 40, s.b.y + 14, { steps: 4 });
        await p.mouse.move(t.x, t.y, { steps: 10 });
        await p.mouse.up();
    });
}
await way('script set, no event', async () => { await f.evaluate(() => { document.getElementById('b').value = 'scripted'; }); });
await way('script set + synthetic input', async () => { await f.evaluate(() => { const b = document.getElementById('b'); b.value = 'scripted2'; b.dispatchEvent(new Event('input', { bubbles: true })); }); });
await way('script setRangeText', async () => { await f.evaluate(() => { document.getElementById('b').setRangeText('R'); }); });
await way('execCommand insertText on focused', async () => { await f.evaluate(() => { document.getElementById('a').focus(); document.execCommand('insertText', false, 'EX'); }); });
await way('textarea type', async () => { await f.locator('#t').click(); await p.keyboard.type('q'); await p.keyboard.press('Enter'); });
await way('checkbox click', async () => { await f.locator('#c').click(); });
await way('label click', async () => { await f.locator('#lc').click({ position: { x: 3, y: 5 } }); });
await way('checkbox space', async () => { await f.locator('#c').focus(); await p.keyboard.press('Space'); });
await way('checkbox script click()', async () => { await f.evaluate(() => document.getElementById('c').click()); });
await way('radio click', async () => { await f.locator('#r2').click(); });
await way('radio arrow', async () => { await p.keyboard.press('ArrowLeft'); });
await way('select keyboard', async () => { await f.locator('#s').focus(); await p.keyboard.press('ArrowDown'); });
await way('select selectOption', async () => { await f.locator('#s').selectOption('three'); });
await way('range click', async () => { const r = await box('#rg'); await p.mouse.click(r.b.x + r.b.width * 0.8, r.y); });
await way('range arrow', async () => { await p.keyboard.press('ArrowLeft'); });
await way('date type', async () => { await f.locator('#d').click(); await p.keyboard.type('03152026'); });
await way('reset button', async () => { await f.locator('#fx').click(); await p.keyboard.type('Z'); await f.locator('#rs').click(); });
console.log(JSON.stringify({ engine, inFrame, version: browser.version(), out }));
await browser.close();
