import { test, expect, ORIGIN, type SandboxDriver } from './fixture';
import { inView, waitInView } from './strict-view';
import type { Page } from '@playwright/test';
import { cssLoadBound, RENDER_RULES, sanitizeRender, VIEW_MAX_DISTINCT_URLS, VIEW_MAX_OPERATION_MS, VIEW_OVERRUN_WINDOW_MS, VIEW_RENDER_MAX_LENGTH, VIEW_STILL_PSEUDO_ELEMENTS, VIEW_URLS_PER_SECOND } from '@src/lib/in-sandbox-view';
import { busyOf, busyShare, describeShare, idleBaseline, lag, loadedShare, operationCost, startLag, viewBound } from './host-share';

/**
 * The strict view's findings of R5 where the browser decides, on Chromium, Firefox and WebKit: loads that only
 * the platform sees (R5:M-3), the view's time budget and its one operation (R5:M-2), the cost of the still stylesheet
 * (R5:M-1), the renderer's prediction of the policy (R5:N-3) and the prelude's error listener (R5:N-2). The library's own logic is unit-tested in
 * test/unit/strict-view-budget.test.ts.
 */

// What the host page's thread had left: its busy share against its own idle baseline (./host-share.ts).

async function mountEntry(sandbox: SandboxDriver, source: string, config: Record<string, unknown> = {}) {
    await sandbox.registerFiles({ 'main.js': source });
    expect(await sandbox.mount({ mode: 'strict', entry: 'main.js', scriptUnsafe: true, ...config })).toBe('ready');
}

// A one-pixel PNG, for an origin the view's policy admits (served by the test, never by a network).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const A_EXAMPLE = /^https?:\/\/a\.example(:\d+)?\//;

test.describe('N-3 (class B): the renderer keeps a URL only where every engine admits it', () => {
    test('exact origins are kept; an http: image of a listed https: origin too (port 80 or 443); http: media of one, https: of a listed http: loopback origin, and an http: image of a listed https: loopback origin are dropped and reported', async ({ sandbox, page, browserName }) => {
        await page.route(A_EXAMPLE, route => route.fulfill({ body: PNG, contentType: 'image/png' }));
        const port = new URL(ORIGIN).port;
        await mountEntry(sandbox, `sandboxView.render('<img id="a" src="https://a.example/1.png"><img id="b" src="http://a.example/2.png"><img id="c" src="http://a.example:443/3.png">'
            + '<video id="v" src="http://a.example/v.mp4"></video><video id="w" src="https://a.example/w.mp4"></video>'
            + '<img id="l" src="https://localhost:${port}/l.png"><img id="m" src="${ORIGIN}/test/e2e/pixel.png"><img id="u" src="http://127.0.0.1:${port}/u.png">');`,
            { origins: { images: ['https://a.example', ORIGIN, `https://127.0.0.1:${port}`], media: ['https://a.example'] } });
        await waitInView(page, browserName, `!!document.getElementById('u')`);
        const kept = await inView(page, browserName, `['a', 'b', 'c', 'v', 'w', 'l', 'm', 'u'].map(id => document.getElementById(id).getAttribute('src'))`);
        // v, l and u are dropped by the renderer: Chromium (all three) and WebKit (v) refuse them
        expect(kept).toEqual(['https://a.example/1.png', 'http://a.example/2.png', 'http://a.example:443/3.png', null, 'https://a.example/w.mp4', null, `${ORIGIN}/test/e2e/pixel.png`, null]);
        await page.waitForTimeout(500);
        const reported = (await sandbox.violations()).map(v => `${v.directive} ${v.blockedURI}`).sort();
        expect(reported).toEqual([`img-src http://127.0.0.1:${port}/u.png`, `img-src https://localhost:${port}/l.png`, 'media-src http://a.example/v.mp4'].sort());
    });
});

test.describe("N-2 (class G): the strict prelude's error listener reads no getter the guest replaced", () => {
    const THROW = `() => { throw new Error('guest getter'); }`;
    for (const [name, error, message] of [['throwing', THROW, THROW], ['spoofed as muted', '() => null', `() => 'Script error.'`]] as const) {
        test(`ErrorEvent.prototype's error and message ${name}: a later error is cancelled and logged, and the sandbox stays ready`, async ({ sandbox }) => {
            await mountEntry(sandbox, `
                Object.defineProperty(ErrorEvent.prototype, 'error', { configurable: true, get: ${error} });
                Object.defineProperty(ErrorEvent.prototype, 'message', { configurable: true, get: ${message} });
                globalThis.later = () => setTimeout(() => { throw new Error('later'); }, 0);`);
            await sandbox.run('later()');
            // not throwing: it would end the sandbox in Firefox with "the guest entry failed to start"
            await sandbox.waitForLog(/^Uncaught .*later/);
            await new Promise(resolve => setTimeout(resolve, 500));
            expect(await sandbox.state()).toBe('ready');
            expect((await sandbox.logs()).filter(line => line.includes('later'))).toHaveLength(1);
        });
    }
});

// Renders `perRender` elements into #a, as fast as the view acknowledges them, each with a CSS background of its own,
// new in every render: `prefix` followed by the render's number and the element's.
const backgroundFlood = (prefix: string, perRender: number) => `
    sandboxView.render('<div id="a"></div>');
    globalThis.flood = (seconds) => {
        let n = 0;
        const end = Date.now() + seconds * 1000;
        const step = () => {
            let html = '';
            for (let i = 0; i < ${perRender}; i++) html += '<i style="display:block;width:1px;height:1px;background:url(${prefix}' + n + '_' + i + '.png)"></i>';
            n++;
            sandboxView.render(html, 'a');
            if (Date.now() < end) setTimeout(step, 5);
        };
        step();
    };`;

test.describe('M-3 (class E-net and P): every load the view makes is charged to its load budget, whatever named it', () => {
    const PER_RENDER = 500;
    const WINDOW_S = 8;
    // The loads the view may start over any `seconds` (VIEW_URLS_PER_SECOND, "The bound"; backlog S73): the rate, the
    // second's worth the budget holds, one operation's precharge (here a render's PER_RENDER url() tokens, its only
    // loads), and the credit carried in, at most a second's worth. No stylesheet is in the view, so nothing else.
    // Derived from the code, not measured: every load is charged before the browser can start it.
    const bound = (seconds: number) => VIEW_URLS_PER_SECOND * seconds + VIEW_URLS_PER_SECOND + PER_RENDER + VIEW_URLS_PER_SECOND;
    // Refusals the view's document reports over a window that starts once the flood is under way: twice the rate. Not
    // the bound above, which is of loads: WebKit reports some refusals twice, and each report past the credit is charged
    // only once it is made (at most 1.8 times the rate, Firefox).
    const ADMITTED = 2 * VIEW_URLS_PER_SECOND * WINDOW_S;
    // the host page's share over the same WINDOW_S: the best of 2 windows of half of it
    const WINDOWS = { windows: 2, ms: (WINDOW_S * 1000) / 2 };

    test(`CSS backgrounds to an admitted origin: at most VIEW_URLS_PER_SECOND loads per second, and the host page keeps about its share`, async ({ sandbox, page, browserName }) => {
        test.setTimeout(90000);
        const requested: number[] = [];
        await page.route(A_EXAMPLE, route => { requested.push(Date.now()); return route.fulfill({ body: PNG, contentType: 'image/png' }); });
        await mountEntry(sandbox, backgroundFlood('https://a.example/', PER_RENDER), { origins: { images: ['https://a.example'] } });
        await page.waitForTimeout(300);
        const idle = await idleBaseline(page);
        const started = Date.now();
        await sandbox.run(`flood(${WINDOW_S + 6})`);
        await page.waitForTimeout(3000);
        const from = Date.now();
        const share = await loadedShare(page, idle, WINDOWS);
        const until = from + WINDOW_S * 1000;
        // Counted over the whole flood, from the first render: a render's loads are charged when it is applied, so the
        // budget holds the next one back until they are repaid. On a fast runner that wait can cover the whole window
        // (0 loads in it, WebKit in CI), which is the budget working; the host-share check below is over the window.
        const loads = requested.filter(time => time >= started && time < until).length;
        const seconds = (until - started) / 1000;
        console.log(`MEASURED ${browserName} M-3 CSS backgrounds, admitted origin: ${loads} loads over the ${seconds.toFixed(1)} s flood, ${(loads / seconds).toFixed(0)} per second (budget ${VIEW_URLS_PER_SECOND}, bound ${bound(seconds).toFixed(0)}); ${describeShare(share)}`);
        // Firefox: about 1400 loads per second under the flood, within the bound (S73; unbounded, 5000 over an 11.1 s flood)
        expect(loads).toBeLessThanOrEqual(bound(seconds));
        expect(loads).toBeGreaterThan(0);
        expect(share.busy).toBeLessThanOrEqual(viewBound(true)); // docs/API.md (a) for a view that loads: 40%, plus 10 points
    });

    test(`CSS backgrounds from a refused source: at most VIEW_URLS_PER_SECOND refusals per second, and the host page keeps about its share`, async ({ sandbox, page, browserName }) => {
        test.setTimeout(90000);
        await mountEntry(sandbox, backgroundFlood('https://r.example/', PER_RENDER));
        await waitInView(page, browserName, `!!document.getElementById('a')`);
        // the refusals the view's document saw, counted in the view, from outside
        await inView(page, browserName, `(window.__refusals = [], addEventListener('securitypolicyviolation', () => window.__refusals.push(performance.now() + performance.timeOrigin)), true)`);
        await page.waitForTimeout(300);
        const idle = await idleBaseline(page);
        await sandbox.run(`flood(${WINDOW_S + 6})`);
        await page.waitForTimeout(3000);
        const from = Date.now();
        const share = await loadedShare(page, idle, WINDOWS);
        const times = await inView<number[]>(page, browserName, `window.__refusals`) as number[];
        const refusals = times.filter(time => time >= from && time < from + WINDOW_S * 1000).length;
        console.log(`MEASURED ${browserName} M-3 CSS backgrounds, refused source: ${(refusals / WINDOW_S).toFixed(0)} refusals per second (budget ${VIEW_URLS_PER_SECOND}); ${describeShare(share)}`);
        expect(refusals).toBeLessThanOrEqual(ADMITTED);
        expect(refusals).toBeGreaterThan(0);
        expect(share.busy).toBeLessThanOrEqual(viewBound(true)); // refusals are charged as loads: 40%, plus 10 points
    });

    test('S73: behind a slow server (every response 1 s late) the burst is the same bound: it no longer grows with the latency', async ({ sandbox, page, browserName }) => {
        test.setTimeout(90000);
        const FLOOD_S = 6;
        const requested: number[] = [];
        await page.route(A_EXAMPLE, async route => {
            requested.push(Date.now());
            await new Promise(resolve => setTimeout(resolve, 1000));
            await route.fulfill({ body: PNG, contentType: 'image/png' }).catch(() => {}); // the page may be gone
        });
        await mountEntry(sandbox, backgroundFlood('https://a.example/', PER_RENDER), { origins: { images: ['https://a.example'] } });
        await page.waitForTimeout(300);
        const started = Date.now();
        await sandbox.run(`flood(${FLOOD_S})`);
        await page.waitForTimeout(FLOOD_S * 1000 + 1500);
        const until = started + FLOOD_S * 1000;
        const loads = requested.filter(time => time >= started && time < until).length;
        // the first second: before S73 every render the view applied before the first response ended went through
        const first = requested.filter(time => time >= started && time < started + 1000).length;
        const seconds = (until - started) / 1000;
        console.log(`MEASURED ${browserName} S73 CSS backgrounds behind a 1 s server: ${first} loads in the first second (bound ${bound(1)}), ${loads} over the ${seconds.toFixed(1)} s flood (bound ${bound(seconds).toFixed(0)})`);
        expect(first).toBeLessThanOrEqual(bound(1));
        expect(loads).toBeLessThanOrEqual(bound(seconds));
        expect(loads).toBeGreaterThan(0);
    });

    test('S73: counting what CSS can load costs little next to parsing and cleaning it (a 256 KiB render full of CSS)', async ({ sandbox, page, browserName }) => {
        test.setTimeout(60000);
        await mountEntry(sandbox, `sandboxView.render('<div id="a"></div>');`);
        await waitInView(page, browserName, `!!document.getElementById('a')`);
        // In the view's own document: the parse the view does for every render (template.innerHTML), and the parse and
        // the renderer's cleaning (sanitizeRender, with animations allowed, so that every style attribute is kept and
        // counted), against what the count adds (what cssLoadsOf does: read every style attribute and every <style>'s
        // text, and count them joined, through cssLoadBound). Half of the render is style attributes, half one
        // stylesheet, every rule naming two URLs: without escapes, with one escape per rule, and with every code point of
        // every name escaped, the most escapes such CSS holds (with animations not allowed, the default, the renderer
        // drops every style attribute with a backslash: only the stylesheet's would be counted).
        type Cost = { parse: number; clean: number; count: number; tokens: number; bound: number; length: number };
        // run from a timer in the view, and read once done: one evaluation may take no more than 3 s (strict-view.ts)
        await inView(page, browserName, `(window.__s73 = null, setTimeout(() => {
            const count = (${cssLoadBound.toString()});
            const sanitize = (${sanitizeRender.toString()});
            const rules = ${JSON.stringify(RENDER_RULES)};
            const half = ${VIEW_RENDER_MAX_LENGTH / 2};
            const escape = (name) => name.split('').map(c => '\\\\' + c.charCodeAt(0).toString(16) + ' ').join('');
            const render = (url, imageSet, color) => {
                let attributes = '';
                for (let i = 0; attributes.length < half - 300; i++) attributes += '<i style="background: ' + url + '(https://a.example/' + i + '.png), ' + imageSet + '(\\'x.png\\' 1x); ' + color + ': red"></i>';
                let sheet = '';
                for (let i = 0; sheet.length < half - 300; i++) sheet += '.c' + i + ' { background: ' + url + '(https://a.example/s' + i + '.png), ' + imageSet + '("y.png" 1x); ' + color + ': red }\\n';
                return attributes + '<style>' + sheet + '</style>';
            };
            // each the best of 3 rounds of 10 runs, after 5 to warm up: Firefox's clock moves in whole milliseconds, its
            // compiler takes a few runs, and the machine is shared
            const timed = (run) => {
                for (let i = 0; i < 5; i++) run();
                let best = Infinity;
                for (let round = 0; round < 3; round++) {
                    const t = performance.now();
                    for (let i = 0; i < 10; i++) run();
                    best = Math.min(best, (performance.now() - t) / 10);
                }
                return best;
            };
            const measure = (html) => {
                const parsed = () => {
                    const template = document.createElement('template');
                    template.innerHTML = html;
                    return template.content;
                };
                // the renderer, with animations allowed, as the view runs it: it collects the style attributes it keeps
                const switches = { animations: true, autoplay: false, stylesheets: true };
                const cleaned = () => {
                    const content = parsed();
                    const context = { target: 'div', animating: [], origins: { images: ['https://a.example'] }, refused: [], urls: 0, loads: [], css: [] };
                    sanitize(content, () => null, () => false, rules, switches, { elements: 50000, depth: 256, urls: 1000 }, context);
                    return { content, context };
                };
                // what cssLoadsOf does with them: the <style> texts and the stylesheet links read, and all counted joined
                const texts = ({ content, context }) => {
                    const out = context.css.slice();
                    const styles = content.querySelectorAll('style');
                    for (let i = 0; i < styles.length; i++) out.push(String(styles[i].textContent));
                    content.querySelectorAll('link');
                    return out;
                };
                const counted = (list) => count(list.join('\\n'), 200);
                const result = cleaned();
                const list = texts(result);
                const bound = counted(list);
                const parse = timed(parsed);
                const clean = timed(cleaned);
                const whole = timed(() => counted(texts(result)));
                const tokens = timed(() => counted(list));
                return { parse, clean, count: whole, tokens, bound, length: html.length };
            };
            window.__s73 = [measure(render('url', 'image-set', 'color')), measure(render('url', 'image-set', 'co\\\\6c or')), measure(render(escape('url'), escape('image-set'), 'color'))];
        }, 0), true)`);
        const measured = await waitInView<Cost[]>(page, browserName, `window.__s73`, 50000);
        for (const [kind, cost] of [['without escapes', measured[0]!], ['with an escape per rule', measured[1]!], ['every name escaped', measured[2]!]] as const) {
            console.log(`MEASURED ${browserName} S73 counting a ${cost.length}-character render full of CSS, ${kind} (${cost.bound} loads at most): parse ${cost.parse.toFixed(2)} ms, parse and clean ${cost.clean.toFixed(2)} ms, count ${cost.count.toFixed(2)} ms (${Math.round((cost.count / cost.parse) * 100)}% of the parse, ${Math.round((cost.count / cost.clean) * 100)}% of parse and clean; of it, cssLoadBound ${cost.tokens.toFixed(2)} ms), best of 3 rounds of 10`);
            expect(cost.length).toBeLessThanOrEqual(VIEW_RENDER_MAX_LENGTH);
            expect(cost.bound).toBeGreaterThan(0);
        }
        // Against what the view does with every render anyway, parse and clean (it lays out and paints besides): Firefox
        // parses three to seven times as fast as the others, and there the count is about half of the bare parse
        for (const cost of measured) expect(cost.count).toBeLessThan(cost.clean / 2);
    });

    test('observing the loads costs nothing while the view loads nothing', async ({ sandbox, page, browserName }) => {
        test.setTimeout(60000);
        await page.route(A_EXAMPLE, route => route.fulfill({ body: PNG, contentType: 'image/png' }));
        const before = await idleBaseline(page); // no sandbox
        await mountEntry(sandbox, `sandboxView.render('<img src="https://a.example/1.png"><i style="background:url(https://a.example/2.png)">x</i>');`, { origins: { images: ['https://a.example'] } });
        await page.waitForTimeout(1000);
        const idle = await idleBaseline(page);
        const busy = busyOf(idle.count, idle.ms, before);
        console.log(`MEASURED ${browserName} M-3 idle: host ticks per ${before.ms} ms without a sandbox ${before.count}, with an idle view that loaded ${idle.count} (${Math.round(busy * 100)}% busy)`);
        expect(busy).toBeLessThan(0.05); // no documented share ("costs nothing"): the spec's own 5% stands
    });
});

// The cost of the still stylesheet itself, measured in the view: a replacement of `count` elements of `markup` in #a,
// its layout forced and its rendering update waited for, after a first fill (so that the replacement replaces). Run in
// the view's own document, from outside, so the renderer's own work is not in it: what is compared is the style and
// layout work the sheet adds to every element.
const replacementCost = async (page: Page, browserName: string, markup: string, count: number) => {
    await inView(page, browserName, `(window.__cost = null, (async () => {
        const a = document.getElementById('a');
        const html = ${JSON.stringify(markup)}.repeat(${count});
        a.innerHTML = html;
        document.elementFromPoint(0, 0);
        await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
        const start = performance.now();
        a.innerHTML = html;
        document.elementFromPoint(0, 0);
        const flushed = performance.now() - start;
        await new Promise(resolve => requestAnimationFrame(() => resolve(0)));
        const frame = performance.now();
        await new Promise(resolve => setTimeout(resolve, 0));
        window.__cost = flushed + performance.now() - frame;
        a.textContent = '';
    })(), true)`);
    return Math.round(await waitInView<number>(page, browserName, 'window.__cost', 120000));
};

test.describe("M-1 (class P, the library's own mitigation): the still stylesheet costs a large replacement little more than the elements do", () => {
    // The bound: the `*` rule may add at most the elements' own cost (twice in all), and each rule for a pseudo-element
    // the guest's CSS named at most that again (one more style resolution per element and rule). Without it (a rule
    // for every listed name, whatever the guest named), 37 449 elements replaced cost: Firefox 59–222 times
    // (22–30 s: ::first-letter and ::first-line), Chromium 3.7–7.9 times, WebKit 1.6–3 times. The runs alternate, and
    // each side keeps its best of three, on the same machine.
    const COUNT = 37449;
    const NAMED = ['before', 'after', 'marker'];
    const cases: [string, string, number][] = [
        ['no pseudo-element named', '', 2],
        [`${NAMED.join(', ')} named`, `<style>.x::before, .x::after { content: ''; } li::marker { color: red }</style>`, 1 + NAMED.length],
    ];
    for (const markup of ['<i></i>', '<p>x</p>']) {
        for (const [name, sheet, bound] of cases) {
            test(`${COUNT} × ${markup}, ${name}: at most ${bound} times`, async ({ sandbox, page, browserName }) => {
                test.setTimeout(300000);
                const best: Record<string, number> = {};
                for (let round = 0; round < 3; round++) {
                    for (const allowAnimations of [true, false]) {
                        await mountEntry(sandbox, `sandboxView.render(${JSON.stringify(sheet + '<div id="a"></div>')});`, { allowAnimations });
                        await waitInView(page, browserName, `!!document.getElementById('a')`);
                        const cost = await replacementCost(page, browserName, markup, COUNT);
                        best[String(allowAnimations)] = Math.min(best[String(allowAnimations)] ?? Infinity, cost);
                    }
                }
                const ratio = best.false! / best.true!;
                console.log(`MEASURED ${browserName} M-1 replacing ${COUNT} × ${markup} in the view, ${name}: allowAnimations true ${best.true} ms, false ${best.false} ms (${ratio.toFixed(2)} times)`);
                expect(ratio).toBeLessThanOrEqual(bound);
            });
        }
    }

    // What the view's rules are: the one for every element, then one per supported listed name its guest CSS named, in
    // the order the CSS arrived; an escape names them all.
    const rulesInView = (page: Page, browserName: string) => inView<{ selectors: string[]; supported: string[] }>(page, browserName, `(() => {
        const layer = document.head.firstElementChild.sheet.cssRules[0];
        return {
            selectors: Array.from(layer.cssRules, rule => rule.selectorText.replace(/^\\*::/, '::')), // every engine writes *::x as ::x
            // what the view gives a rule: a name the engine supports, and a ::-webkit- name its parser keeps
            supported: ${JSON.stringify([...VIEW_STILL_PSEUDO_ELEMENTS])}.filter(name => {
                if (CSS.supports('selector(*::' + name + ')')) return true;
                if (name.indexOf('-webkit-') !== 0) return false;
                const sheet = new CSSStyleSheet();
                try { sheet.insertRule('*::' + name + '{}'); } catch (error) { return false; }
                return sheet.cssRules.length === 1;
            }),
        };
    })()`) as Promise<{ selectors: string[]; supported: string[] }>;

    test("the view's rules for pseudo-elements: none until guest CSS names one, then the ones it named this engine supports; an escape adds every one", async ({ sandbox, page, browserName }) => {
        await mountEntry(sandbox, `sandboxView.render('<p id="p">p</p>'); globalThis.css = (text) => sandboxView.render('<style>' + text + '</style>', 'p');`, { allowAnimations: false });
        await waitInView(page, browserName, `!!document.getElementById('p')`);
        expect((await rulesInView(page, browserName)).selectors).toEqual(['*']);
        await sandbox.run(`css('.a:before { color: red } li::marker { color: blue } input::file-selector-button { color: green }')`);
        await waitInView(page, browserName, `document.querySelectorAll('style').length === 2`);
        const named = await rulesInView(page, browserName);
        expect(named.selectors).toEqual(['*', ...['before', 'marker', 'file-selector-button'].filter(name => named.supported.includes(name)).map(name => `::${name}`)]);
        await sandbox.run(`css('.a::bef\\\\6fre { color: red }')`);
        await waitInView(page, browserName, `document.querySelector('#p style') && document.querySelector('#p style').textContent.includes('6fre')`);
        const all = await rulesInView(page, browserName);
        console.log(`MEASURED ${browserName} M-1: ${all.selectors.length - 1} rules for pseudo-elements once every name was named, of ${VIEW_STILL_PSEUDO_ELEMENTS.length} listed`);
        // one rule per supported name (an engine writes an alias under its standard name: -moz-list-bullet as ::marker)
        expect(all.selectors).toHaveLength(1 + all.supported.length);
        expect(all.supported.length).toBeGreaterThan(5);
    });
});


// What applying `html` costs here, the calibration of the operations below: operationCost() (./host-share.ts).

// An operation whose cost grows with `n` on every engine, faster than `n`: elements matched by a guest rule whose :has()
// looks at all their later siblings (16 000 of them: Chromium 1.6 s, WebKit 2.2 s, Firefox 2.9 s). Inline elements
// restyled by a rule (30 000 take Chromium 7.5–8.3 s) cost Firefox and WebKit only 0.3 s, so they are not an
// operation that grows on every engine (R5:M-2).
const heavy = (n: number, text = 'x') => `<style>i:has(~ b){color:red}</style><div>${`<i>${text}</i>`.repeat(n)}<b>y</b></div>`;
const SIZES = [1000, 2000, 4000, 8000, 12000, 16000, 24000, 30000];

// The smallest size whose operation costs at least `ms` here, with its cost; the largest if none does.
async function sizeFor(page: Page, ms: number) {
    let found = { n: SIZES[0]!, cost: 0 };
    for (const n of SIZES) {
        found = { n, cost: await operationCost(page, heavy(n)) };
        if (found.cost >= ms) break;
    }
    return found;
}

test.describe('M-2 (class P): the view charges every operation in full; the second past VIEW_MAX_OPERATION_MS within VIEW_OVERRUN_WINDOW_MS ends the sandbox (S72)', () => {
    const MINUTES = VIEW_OVERRUN_WINDOW_MS / 60000;
    const REASON = `the view spent more than ${VIEW_MAX_OPERATION_MS} ms on one operation twice within ${MINUTES} minutes`;
    const FIRST_OVERRUN_LINE = `[Sandbox] the view spent more than ${VIEW_MAX_OPERATION_MS} ms on one operation; a second such operation within ${MINUTES} minutes ends the sandbox.`;

    // Backlog S72, the repeated-overrun rule: before it, the first operation past the limit ended the sandbox, which on a
    // loaded machine ended healthy ones (the meter measures wall time: a proxy of the view's own cost).
    test(`one operation past ${VIEW_MAX_OPERATION_MS} ms, then operations well under it: the sandbox stays ready, said once; a second past it within the window ends it with the reason`, async ({ sandbox, page, browserName }) => {
        test.setTimeout(300000);
        const long = await sizeFor(page, 2 * VIEW_MAX_OPERATION_MS);
        const short = { n: SIZES[0]!, cost: await operationCost(page, heavy(SIZES[0]!)) };
        console.log(`MEASURED ${browserName} M-2 calibration: ${long.n} elements under :has() ${long.cost} ms, ${short.n} ${short.cost} ms`);
        test.skip(long.cost < 1.5 * VIEW_MAX_OPERATION_MS, `the heaviest operation of the family takes ${long.cost} ms here`);
        expect(short.cost).toBeLessThan(VIEW_MAX_OPERATION_MS / 2);
        await mountEntry(sandbox, `sandboxView.render('<div id="a"></div>');
            globalThis.go = (n) => sandboxView.render(${JSON.stringify(heavy(1))}.replace('<i>x</i>', '<i>x</i>'.repeat(n)), 'a');
            globalThis.small = (k) => sandboxView.render('<p id="p' + k + '">' + k + '</p>', 'a');`);
        const reasons: string[] = [];
        await page.exposeFunction('__terminated', (reason: string) => reasons.push(reason));
        await page.evaluate(() => document.querySelector('web-sandbox')!.addEventListener('terminated', (e: any) => (window as any).__terminated(e.detail.reason)));
        // past the limit: an overrun, said once on sandbox-log; the sandbox stands (before S72 it ended here)
        await sandbox.run(`go(${long.n})`);
        await sandbox.waitForLog(FIRST_OVERRUN_LINE, 3 * long.cost + 30000);
        const first = Date.now();
        expect(await sandbox.state()).toBe('ready');
        // operations well under it: each applied, the first once the overrun's debt is repaid (five times its cost)
        await sandbox.run(`go(${short.n})`);
        await waitInView(page, browserName, `document.querySelectorAll('#a i').length === ${short.n}`, 8 * long.cost + 30000);
        const resumed = Date.now() - first;
        for (let k = 1; k <= 3; k++) {
            await sandbox.run(`small(${k})`);
            await waitInView(page, browserName, `!!document.getElementById('p${k}')`, 30000);
        }
        await page.waitForTimeout(500);
        console.log(`MEASURED ${browserName} M-2 the first operation after the overrun applied ${resumed} ms after it was said`);
        expect(await sandbox.state()).toBe('ready');
        expect(reasons).toEqual([]);
        // a second past the limit, within the window: ended, with the reason
        await sandbox.run(`go(${long.n})`);
        await expect.poll(() => sandbox.state(), { timeout: 3 * long.cost + 30000 }).toBe('terminated');
        expect(Date.now() - first).toBeLessThan(VIEW_OVERRUN_WINDOW_MS);
        expect(reasons).toEqual([REASON]);
        expect((await sandbox.logs()).filter(line => line === FIRST_OVERRUN_LINE)).toHaveLength(1);
    });

    test('operations of 1–1.5 s, one after the other, keep the view to about its long-run share of the host page', async ({ sandbox, page, browserName }) => {
        test.setTimeout(240000);
        // a size whose operation costs about 1.1 s here: the view's own work on top, and the machine's noise, keep it under
        // VIEW_MAX_OPERATION_MS (calibrated at 1.56 s, Chromium's went past it once), interpolated from the calibration (the cost grows as n²)
        const probe = await sizeFor(page, 1000);
        const n = Math.min(SIZES[SIZES.length - 1]!, Math.max(SIZES[0]!, Math.round(probe.n * Math.sqrt(1100 / Math.max(1, probe.cost)))));
        const cost = await operationCost(page, heavy(n));
        console.log(`MEASURED ${browserName} M-2 calibration: ${n} elements under :has() ${cost} ms`);
        test.skip(cost < 700 || cost > 1400, `no size of the family costs about 1.1 s here (${n}: ${cost} ms)`);
        await mountEntry(sandbox, `
            sandboxView.render('<div id="a"></div>');
            globalThis.flood = (seconds) => {
                const html = [${JSON.stringify(heavy(n, 'x'))}, ${JSON.stringify(heavy(n, 'y'))}];
                let k = 0;
                const end = Date.now() + seconds * 1000;
                const step = () => { sandboxView.render(html[k++ % 2], 'a'); if (Date.now() < end) setTimeout(step, 50); };
                step();
            };`);
        await page.waitForTimeout(300);
        // windows of 15 s: each holds two or more of the flood's periods (an operation of about 1.1 s, then the budget's
        // wait of about 5 times that), so each reads the long-run share
        const share = await busyShare(page, () => sandbox.run('flood(40)'), { windows: 2, ms: 15000 }, 2000);
        console.log(`MEASURED ${browserName} M-2 operations of ${cost} ms one after the other: ${describeShare(share)}`);
        expect(await sandbox.state()).toBe('ready');
        expect(share.busy).toBeLessThanOrEqual(viewBound(false)); // docs/API.md (a): 20%, plus 10 points
    });
});

test.describe('M-4 (class P): one view loads at most VIEW_MAX_DISTINCT_URLS distinct URLs', () => {
    test(`a flood of renders of 1000 new images: ${VIEW_MAX_DISTINCT_URLS} load, the render past them is refused, and said`, async ({ sandbox, page, browserName }) => {
        test.setTimeout(240000);
        const requested = new Set<string>();
        await page.route(A_EXAMPLE, route => { requested.add(route.request().url()); return route.fulfill({ body: PNG, contentType: 'image/png' }); });
        await mountEntry(sandbox, `
            sandboxView.render('<div id="a"></div>');
            globalThis.flood = () => {
                let n = 0;
                const step = () => {
                    let html = '';
                    for (let i = 0; i < 1000; i++) html += '<img width="1" height="1" src="https://a.example/' + n + '_' + i + '.png">';
                    n++;
                    sandboxView.render(html, 'a');
                    // one render each time the load budget has repaid the last (1000 at 200 per second): the worker keeps
                    // only the latest render per target, so a faster guest would skip renders
                    if (n < ${VIEW_MAX_DISTINCT_URLS / 1000 + 2}) setTimeout(step, 6000);
                };
                step();
            };`, { origins: { images: ['https://a.example'] } });
        // the host page's longest stall while the flood runs (unbounded, WebKit's grows past seconds as the count does)
        await startLag(page);
        await sandbox.run('flood()');
        const line = await sandbox.waitForLog(`[Sandbox] sandboxView.render: the view refused a render: the view would load more than ${VIEW_MAX_DISTINCT_URLS} distinct URLs in this environment; nothing of it was applied.`, 150000);
        expect(line).toBeTruthy();
        await page.waitForTimeout(1000);
        const longest = await lag(page);
        console.log(`MEASURED ${browserName} M-4: ${requested.size} distinct URLs requested before the refusal; the host page's longest stall ${longest} ms`);
        expect(requested.size).toBe(VIEW_MAX_DISTINCT_URLS); // every render up to the limit applied, none past it
        expect(await inView<number>(page, browserName, `document.querySelectorAll('#a img').length`)).toBe(1000); // the last render applied
    });
});
