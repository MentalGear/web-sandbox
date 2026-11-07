import { test, expect } from '../../../test/e2e/fixture';
import { inView, waitInView } from '../../../test/e2e/strict-view';

/*
 * Research 25, the cost: what a render that carries the guest's styles costs the view, measured in the real view of a
 * sealed sandbox at its default configuration (allowAnimations false), from the view's first step of the render (it makes
 * its template) to the end of the style and layout work that follows its insertion (forced, in a microtask after the
 * flush, so the stylesheets the view adopts after the insertion are in it). On demand, one engine at a time:
 *   WEB_SANDBOX_MEASURE=1 bunx playwright test docs/research/25_cssom_styles/measure.spec.ts --project=chromium --workers=1
 * It prints `MEASURED {json}` lines: per markup, the median and the spread of the renders. README.md compares the CSSOM
 * path with the inline one it replaced, measured by the same file against the renderer before it (the commands are there).
 */
test.skip(!process.env.WEB_SANDBOX_MEASURE, 'a measurement, run on demand (WEB_SANDBOX_MEASURE=1)');

const repeat = (count: number, piece: (i: number) => string) => Array.from({ length: count }, (_, i) => piece(i)).join('');

/** The markups, each about 100 000 characters: style attributes, <style> elements, neither, and the word `style` in text. */
const MARKUPS: Record<string, string> = {
    'style attributes': repeat(1500, i => `<p style="color: rgb(${i % 250}, 2, 3); margin: 1px 2px; padding: 0">x</p>`),
    'style elements': repeat(500, i => `<style>.c${i} { color: rgb(${i % 250}, 2, 3) } .c${i} > b { margin: 1px }</style><p class="c${i}"><b>x</b></p>`),
    'no style': repeat(2500, i => `<p class="k${i % 9}">x y z</p>`),
    'the word style': repeat(1500, () => '<p title="a style b">style is style </p>'),
};

/** In the view: the time from the template a render makes to the end of the style and layout work after its insertion. */
const INSTRUMENT = `(() => {
    if (window.__costs) return true;
    window.__costs = [];
    window.__t0 = null;
    const createElement = Document.prototype.createElement;
    Document.prototype.createElement = function (name) {
        if (name === 'template' && window.__t0 === null) window.__t0 = performance.now();
        return createElement.apply(this, arguments);
    };
    const replaceChildren = Element.prototype.replaceChildren;
    Element.prototype.replaceChildren = function () {
        const result = replaceChildren.apply(this, arguments);
        const t0 = window.__t0;
        if (t0 !== null) queueMicrotask(() => {
            void document.body.offsetHeight;
            void getComputedStyle(document.body.lastElementChild || document.body).color;
            window.__costs.push(performance.now() - t0);
            window.__t0 = null;
        });
        return result;
    };
    return true;
})()`;

const RENDERS = 9;

test('the cost of a render that carries styles, per markup', async ({ sandbox, page, browserName }) => {
    test.setTimeout(300000);
    expect(await sandbox.registerFiles({ 'main.js': `
        const MARKUPS = ${JSON.stringify(MARKUPS)};
        bridge.expose('render', (name, i) => { sandboxView.render(MARKUPS[name] + '<i id="done-' + i + '"></i>'); return true; });
        sandboxView.render('<p id="ready">ready</p>');` })).toBe('ok');
    expect(await sandbox.mount({ mode: 'sealed', entry: 'main.js' })).toBe('ready');
    await waitInView(page, browserName, "!!document.getElementById('ready')", 10000);
    expect(await inView(page, browserName, INSTRUMENT)).toBe(true);
    const results: Record<string, { median: number; min: number; max: number; length: number }> = {};
    let n = 0;
    for (const name of Object.keys(MARKUPS)) {
        await inView(page, browserName, 'window.__costs.length = 0');
        for (let i = 0; i < RENDERS; i++) {
            expect(await sandbox.call('render', name, ++n)).toBe(true);
            await waitInView(page, browserName, `!!document.getElementById('done-${n}') && window.__t0 === null`, 30000);
        }
        const costs = (await inView<number[]>(page, browserName, '[...window.__costs]')) as number[];
        const sorted = [...costs].sort((a, b) => a - b);
        results[name] = { median: Number(sorted[Math.floor(sorted.length / 2)]!.toFixed(1)), min: Number(sorted[0]!.toFixed(1)), max: Number(sorted.at(-1)!.toFixed(1)), length: MARKUPS[name]!.length };
        expect(costs.length).toBeGreaterThanOrEqual(RENDERS);
    }
    const line = JSON.stringify({ [`${browserName} render cost, ms (median of ${RENDERS})`]: results });
    console.log(`MEASURED ${line}`);
    test.info().annotations.push({ type: 'measured', description: line });
});
