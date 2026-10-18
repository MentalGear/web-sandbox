import { test, expect, ORIGIN, type SandboxDriver } from './fixture';
import { inView, waitInView } from './strict-view';
import type { Page } from '@playwright/test';
import { STILL_PROPERTIES, STILL_PROPERTY_PATTERN, VIEW_MAX_URLS, VIEW_STILL_PSEUDO_ELEMENTS, VIEW_URLS_PER_SECOND } from '@src/lib/in-sandbox-view';

/**
 * Review round 4: the findings where the browser decides, on Chromium, Firefox and WebKit: what reaches the host page's
 * thread from a guest worker's own postMessage (M-1), when a frame's load runs inside the embedder's DOM mutation (L-1),
 * what the style rewrite of `allowAnimations: false` costs (C-2), which parts of the media and form controls can animate
 * (C-7, Chromium), and what the browser does after a render with the URLs it holds (M-2). Each test failed at c7672bb
 * (the measurements say so where they are the evidence). The library's own logic is unit-tested in
 * test/unit/review-round-4.test.ts.
 */

// Ticks of a 10 ms interval on the host page over `ms`: what the host page's thread had left.
const countTicks = (page: Page, ms: number) => page.evaluate((duration) => new Promise<number>(resolve => {
    let count = 0;
    const timer = setInterval(() => count++, 10);
    setTimeout(() => { clearInterval(timer); resolve(count); }, duration);
}), ms);

async function mountEntry(sandbox: SandboxDriver, source: string, config: Record<string, unknown> = {}) {
    await sandbox.registerFiles({ 'main.js': source });
    expect(await sandbox.mount({ mode: 'strict', entry: 'main.js', scriptUnsafe: true, ...config })).toBe('ready');
}

// Every way guest code could find the worker's own channel to its parent: the global, `self`, `globalThis`, `in`,
// Reflect, every prototype of the global, the scope interfaces' prototypes, and MessagePort's postMessage borrowed.
const FIND_POST = `
    const found = [];
    for (const name of ['postMessage', 'onmessage', 'onmessageerror']) {
        if (typeof globalThis[name] !== 'undefined') found.push('globalThis.' + name);
        if (typeof self[name] !== 'undefined') found.push('self.' + name);
        if (name in self) found.push(name + ' in self');
        if (Reflect.get(self, name) !== undefined) found.push('Reflect.get(self, ' + name + ')');
        for (let proto = Object.getPrototypeOf(self); proto; proto = Object.getPrototypeOf(proto)) {
            if (Reflect.getOwnPropertyDescriptor(proto, name)) found.push('a prototype of self has ' + name);
        }
        for (const scope of ['DedicatedWorkerGlobalScope', 'WorkerGlobalScope']) {
            const constructor = globalThis[scope];
            if (constructor && constructor.prototype && name in constructor.prototype) found.push(scope + '.prototype.' + name);
        }
    }
    if (typeof postMessage !== 'undefined') found.push('postMessage');
    try { MessagePort.prototype.postMessage.call(self, 1); found.push('MessagePort.prototype.postMessage on self'); } catch {}
    return found;`;

// The reviewers' flood, as written: four 8 MiB messages per timer tick through the worker's own postMessage.
const FLOOD = `const p = new Uint8Array(8 * 1048576); setInterval(() => { for (let i = 0; i < 4; i++) postMessage(p); }, 0);`;

test.describe("M-1: the guest worker's own postMessage is gone; the library's port is the only path to its parent", () => {
    test('worker mode: no postMessage, onmessage or onmessageerror anywhere in the worker', async ({ sandbox }) => {
        expect(await sandbox.mount({ mode: 'worker', scriptUnsafe: true })).toBe('ready');
        expect(await sandbox.inGuest(FIND_POST)).toEqual([]);
    });

    test("strict mode: none, from the entry's top level on (before the worker has its port) and after", async ({ sandbox }) => {
        await mountEntry(sandbox, `console.log('AT ENTRY ' + typeof postMessage + ' ' + typeof self.postMessage + ' ' + ('onmessage' in self));`);
        await sandbox.waitForLog('AT ENTRY undefined undefined false');
        expect(await sandbox.inGuest(FIND_POST)).toEqual([]);
    });

    for (const mode of ['worker', 'strict'] as const) {
        test(`${mode} mode: under the flood the host page keeps its idle ticks`, async ({ sandbox, page, browserName }) => {
            test.setTimeout(60000);
            if (mode === 'worker') expect(await sandbox.mount({ mode: 'worker', scriptUnsafe: true })).toBe('ready');
            else await mountEntry(sandbox, 'void 0');
            await page.waitForTimeout(300);
            const idle = await countTicks(page, 4000);
            await sandbox.run(FLOOD);
            await page.waitForTimeout(500);
            const loaded = await countTicks(page, 4000);
            console.log(`MEASURED ${browserName} M-1 ${mode} mode: host ticks in 4 s: idle ${idle}, under the flood ${loaded} (${Math.round((1 - loaded / idle) * 100)}% busy)`);
            expect(loaded).toBeGreaterThan(idle * 0.9);
        });
    }
});

// The same class: an uncaught error the worker does not cancel reaches the Worker object of its parent with its message.
// Worker mode's relay now cancels every error it relays once the port is attached (strict mode's prelude did already).
test.describe("M-1's class: the guest worker's uncaught errors reach its parent only as relayed lines", () => {
    for (const mode of ['worker', 'strict'] as const) {
        test(`${mode} mode: errors of 16 Mi characters reported in a loop leave the host page its idle ticks, and are relayed cut`, async ({ sandbox, page, browserName }) => {
            test.setTimeout(60000);
            if (mode === 'worker') expect(await sandbox.mount({ mode: 'worker', scriptUnsafe: true })).toBe('ready');
            else await mountEntry(sandbox, 'void 0');
            await page.waitForTimeout(300);
            const idle = await countTicks(page, 4000);
            await sandbox.run(`const big = 'x'.repeat(2 ** 24); setInterval(() => { reportError(new Error(big)); reportError(new Error(big)); }, 0);`);
            await page.waitForTimeout(500);
            const loaded = await countTicks(page, 4000);
            console.log(`MEASURED ${browserName} ${mode} mode, an error flood: host ticks in 4 s: idle ${idle}, under the flood ${loaded} (${Math.round((1 - loaded / idle) * 100)}% busy)`);
            expect(loaded).toBeGreaterThan(idle * 0.9);
            const line = await sandbox.waitForLog(/^Uncaught (Error: )?x{100}/);
            expect(line.length).toBeLessThanOrEqual(65536);
        });
    }
});

test.describe('L-1: ready is never dispatched from inside the embedder\'s own appendChild() or remove()', () => {
    test('150 moves and removals, each soon after a rebuild, of a cooperative sandbox without allow-scripts', async ({ sandbox, page, browserName }) => {
        test.setTimeout(90000);
        expect(await sandbox.mount({ mode: 'cooperative', capabilities: [], scriptUnsafe: false, html: '<script>console.log(1)</script><p>x</p>' })).toBe('ready');
        const result = await page.evaluate(async () => {
            const el = document.querySelector('web-sandbox') as any;
            const parent = el.parentNode as Node;
            let inside = false;
            let synchronous = 0;
            let readies = 0;
            el.addEventListener('ready', () => {
                readies++;
                if (inside) synchronous++;
            });
            const mutate = (action: () => void) => {
                inside = true;
                try {
                    action();
                } finally {
                    inside = false;
                }
            };
            for (let i = 0; i < 150; i++) {
                mutate(() => parent.appendChild(el)); // a move: torn down, then rebuilt
                await new Promise(resolve => setTimeout(resolve, 12 + Math.random() * 18));
                mutate(() => (i % 2 === 0 ? parent.appendChild(el) : el.remove()));
                if (!el.isConnected) mutate(() => parent.appendChild(el));
            }
            await new Promise(resolve => setTimeout(resolve, 500));
            return { synchronous, readies, state: el.state };
        });
        console.log(`MEASURED ${browserName} L-1: ${result.readies} ready events, ${result.synchronous} of them inside appendChild() or remove()`);
        expect(result.synchronous).toBe(0);
        expect(result.state).toBe('ready');
    });
});

// The longest gap between the host page's 10 ms ticks while `go()` runs in the guest, over `ms`.
const longestGapWhile = (page: Page, ms: number) => page.evaluate((duration) => new Promise<number>(resolve => {
    let last = performance.now();
    let longest = 0;
    const timer = setInterval(() => {
        const now = performance.now();
        longest = Math.max(longest, now - last);
        last = now;
    }, 10);
    (document.querySelector('web-sandbox') as any).execute('go()');
    setTimeout(() => { clearInterval(timer); resolve(Math.round(longest)); }, duration);
}), ms);

test.describe("C-2: with allowAnimations false the renderer's style rewrite multiplies no work", () => {
    // The cost is read as the longest stall of the host page's thread while one render is applied (in Firefox and WebKit
    // the view runs on it; in Chromium it may not, and the numbers are the view's own then). The still stylesheet itself
    // costs style work per element with `false` (its rules for every pseudo-element), whatever the elements carry, so
    // the control is the same number of plain <i> elements: the style attributes must cost the renderer nothing on top.
    test('one render of 262 000 characters of <i style="all:unset"></i>: false costs what false costs for plain <i>, and it is applied', async ({ sandbox, page, browserName }) => {
        test.setTimeout(120000);
        const count = Math.floor(262000 / 26);
        const gaps: Record<string, number> = {};
        for (const [name, element] of [['all:unset', '<i style="all:unset"></i>'], ['plain', '<i></i>']] as const) {
            for (const allowAnimations of [true, false]) {
                await mountEntry(sandbox, `globalThis.go = () => sandboxView.render(${JSON.stringify(element)}.repeat(${count}), 'a'); sandboxView.render('<div id="a"></div>');`, { allowAnimations });
                await waitInView(page, browserName, `!!document.getElementById('a')`);
                await page.waitForTimeout(300);
                gaps[`${name} ${allowAnimations}`] = await longestGapWhile(page, 4000);
                const held = await waitInView<number>(page, browserName, `document.querySelectorAll('#a > i').length`, 30000);
                expect(held, `${name} ${allowAnimations}`).toBe(count);
                // left as written: nothing of it was read or rewritten (at c7672bb, 'all: unset;' with false)
                if (name === 'all:unset') expect(await inView<string>(page, browserName, `document.querySelector('#a > i').getAttribute('style')`)).toBe('all:unset');
            }
        }
        console.log(`MEASURED ${browserName} C-2 longest host stall for one render of ${count} elements: <i style="all:unset"> true ${gaps['all:unset true']} ms, false ${gaps['all:unset false']} ms; plain <i> true ${gaps['plain true']} ms, false ${gaps['plain false']} ms`);
        // at c7672bb: WebKit 10.3 s and Firefox 2.7 s with false, and the render was then refused
        expect(gaps['all:unset false']!).toBeLessThan(gaps['plain false']! * 2 + 300);
    });

    test('a style attribute that names no animation is left exactly as written; one that does loses only its animations', async ({ sandbox, page, browserName }) => {
        await mountEntry(sandbox, `sandboxView.render('<p id="a" style="all:unset">a</p><p id="b" style="COLOR:red;margin:0">b</p><p id="c" style="color: red; transition: color 1s; animation: spin 1s">c</p><p id="d" style="all:unset;animation:spin 1s">d</p>');`, { allowAnimations: false });
        await waitInView(page, browserName, `!!document.getElementById('d')`);
        const styles = await inView<(string | null)[]>(page, browserName, `['a', 'b', 'c', 'd'].map(id => document.getElementById(id).getAttribute('style'))`);
        expect(styles.slice(0, 3)).toEqual(['all:unset', 'COLOR:red;margin:0', 'color: red;']);
        // `all` beside an animation: rewritten without it where the engine keeps `all` as one property (Chromium), gone
        // whole where `all` expands into more properties than the attribute has characters (Firefox, WebKit)
        expect(styles[3] === null || !/anim/i.test(styles[3]!), String(styles[3])).toBe(true);
    });

    test("the engine's animation and transition longhands are all among the ones the view reads", async ({ sandbox, page, browserName }) => {
        await mountEntry(sandbox, `sandboxView.render('<p id="p">p</p>');`);
        await waitInView(page, browserName, `!!document.getElementById('p')`);
        // what every animating shorthand, alias and prefix declares in this engine, against the view's own list
        const missing = await inView<string[]>(page, browserName, `(() => {
            const pattern = new RegExp(${JSON.stringify(STILL_PROPERTY_PATTERN)});
            const listed = new Set(${JSON.stringify(STILL_PROPERTIES)});
            const computed = getComputedStyle(document.documentElement);
            for (let i = 0; i < computed.length; i++) if (pattern.test(computed.item(i))) listed.add(computed.item(i));
            const probe = document.createElement('i');
            probe.setAttribute('style', 'animation: a 1s; transition: all 1s; -webkit-animation: a 1s; -webkit-transition: all 1s; animation-range: normal; animation-trigger: none; animation-timeline: auto; animation-composition: add; transition-behavior: allow-discrete');
            const missing = [];
            for (let i = 0; i < probe.style.length; i++) if (!listed.has(probe.style.item(i))) missing.push(probe.style.item(i));
            return missing;
        })()`);
        expect(missing).toEqual([]);
    });

    // The renderer reads a style attribute only when its text has "anim", "trans" or a backslash (in-sandbox-view.ts,
    // stillStyle): every property of this engine that sets an animation or transition longhand must be named so, `all`
    // aside (it takes CSS-wide keywords only). Every property the engine knows, set to `inherit` on its own.
    test('every property that sets an animation or transition longhand is named with "anim" or "trans", but all', async ({ page }) => {
        const offenders = await page.evaluate((pattern) => {
            const animating = new RegExp(pattern);
            const names = new Set<string>();
            const style = document.createElement('i').style as unknown as Record<string, unknown>;
            for (const key in style) {
                if (typeof style[key] !== 'string' || /^\d+$/.test(key) || key === 'cssText' || key === 'cssFloat') continue;
                names.add(key.includes('-') ? key : key.replace(/^webkit/, '-webkit-').replace(/^moz/, '-moz-').replace(/[A-Z]/g, letter => '-' + letter.toLowerCase()));
            }
            const offenders: string[] = [];
            for (const name of names) {
                const probe = document.createElement('i');
                probe.style.setProperty(name, 'inherit');
                for (let i = 0; i < probe.style.length; i++) {
                    if (!animating.test(probe.style.item(i)) || /anim|trans/i.test(name) || name === 'all') continue;
                    offenders.push(name + ' sets ' + probe.style.item(i));
                    break;
                }
            }
            return { offenders, properties: names.size };
        }, STILL_PROPERTY_PATTERN);
        expect(offenders.properties).toBeGreaterThan(200);
        expect(offenders.offenders).toEqual([]);
    });
});

test.describe('C-7: every -webkit- part of the media and form controls is in the still stylesheet (Chromium)', () => {
    test('the user-agent shadow parts, read through the DevTools protocol', async ({ page, browserName }) => {
        test.skip(browserName !== 'chromium', 'the DevTools protocol of Chromium');
        await page.setContent(`<video controls width="300" height="150"></video><audio controls></audio>
            <input type="range"><input type="date"><input type="time"><input type="datetime-local"><input type="month"><input type="week">
            <input type="color"><input type="file"><input type="search" value="x"><input type="number"><input placeholder="p"><textarea placeholder="p"></textarea>
            <progress></progress><progress value="1" max="2"></progress><meter value="0.5"></meter><details><summary>s</summary>d</details><select><option>o</option></select>`);
        await page.waitForTimeout(500);
        const session = await page.context().newCDPSession(page);
        const { root } = await session.send('DOM.getDocument', { depth: -1, pierce: true }) as { root: any };
        const ids = new Set<string>();
        const visit = (node: any) => {
            const attributes: string[] = node.attributes ?? [];
            for (let i = 0; i + 1 < attributes.length; i += 2) if (attributes[i] === 'pseudo') ids.add(attributes[i + 1]!);
            for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? []), ...(node.pseudoElements ?? [])]) visit(child);
        };
        visit(root);
        await session.detach();
        const webkit = [...ids].filter(id => id.startsWith('-webkit-')).sort();
        console.log(`MEASURED chromium C-7: ${ids.size} user-agent pseudo ids, ${webkit.length} -webkit- ones`);
        expect(webkit.length).toBeGreaterThan(10);
        expect(webkit.filter(id => !(VIEW_STILL_PSEUDO_ELEMENTS as readonly string[]).includes(id))).toEqual([]);
    });
});

// A one-pixel PNG, for an origin the view's policy admits (served by the test, never by a network).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

// Renders `perRender` <img> into #a as fast as the view acknowledges them, for 12 s: each render's URLs new, `prefix`
// followed by the render's number and the image's.
const imageFlood = (prefix: string, perRender: number) => `
    sandboxView.render('<div id="a"></div><p id="b"></p>');
    globalThis.flood = () => {
        let n = 0;
        const end = Date.now() + 12000;
        const step = () => {
            let html = '';
            for (let i = 0; i < ${perRender}; i++) html += '<img src="${prefix}' + n + '_' + i + '">';
            n++;
            sandboxView.render(html, 'a');
            if (Date.now() < end) setTimeout(step, 5);
        };
        step();
    };`;

test.describe('M-2: what the browser does with the URLs a render holds is bounded', () => {
    test('a refused source: the renderer drops every refused URL, and the view reports each as the browser did (img-src, the URL), at most 100', async ({ sandbox, page, browserName }) => {
        await mountEntry(sandbox, `sandboxView.render('<img id="i" src="https://u:p@r.example:8443/p/a.png?q=1#f" alt="x"><video id="v" src="https://r.example/v.mp4" poster="https://r.example/p.png"></video><picture><source id="s" srcset="https://r.example/s.png"><img alt="y"></picture>' + '<img src="https://r.example/many.png">'.repeat(150));`);
        await waitInView(page, browserName, `!!document.getElementById('s')`);
        const kept = await inView<(string | null)[]>(page, browserName, `[['i', 'src'], ['v', 'src'], ['v', 'poster'], ['s', 'srcset']].map(([id, name]) => document.getElementById(id).getAttribute(name)).concat(String(document.querySelectorAll('[src], [srcset], [poster]').length))`);
        expect(kept).toEqual([null, null, null, null, '0']);
        await page.waitForTimeout(500);
        const violations = await sandbox.violations();
        const summary = violations.map(v => [v.directive, v.blockedURI, v.source]);
        expect(summary.slice(0, 4)).toEqual([
            ['img-src', 'https://r.example:8443/p/a.png?q=1', 'view'],
            ['media-src', 'https://r.example/v.mp4', 'view'],
            ['img-src', 'https://r.example/p.png', 'view'],
            ['img-src', 'https://r.example/s.png', 'view'],
        ]);
        expect(violations.filter(v => v.directive === 'img-src')).toHaveLength(100); // VIOLATION_EVENT_LIMIT per directive
        expect(violations.filter(v => v.directive === 'media-src')).toHaveLength(1);
    });

    test('an admitted origin, and a relative URL, are kept; an http: URL of an admitted https: origin too (the policy upgrades it)', async ({ sandbox, page, browserName }) => {
        await page.route('https://a.example/**', route => route.fulfill({ body: PNG, contentType: 'image/png' }));
        await mountEntry(sandbox, `sandboxView.render('<img id="a" src="https://a.example/1.png"><img id="b" src="http://a.example/2.png"><img id="c" src="x.png"><img id="d" src="https://a.example:8443/3.png">');`, { origins: { images: ['https://a.example'] } });
        await waitInView(page, browserName, `!!document.getElementById('d')`);
        expect(await inView(page, browserName, `['a', 'b', 'c', 'd'].map(id => document.getElementById(id).getAttribute('src'))`)).toEqual(['https://a.example/1.png', 'http://a.example/2.png', 'x.png', null]);
        await page.waitForTimeout(300);
        expect((await sandbox.violations()).map(v => [v.directive, v.blockedURI])).toEqual([['img-src', 'https://a.example:8443/3.png']]);
    });

    // A refused source: the reviewers' 6500 <img> per render (21–45% busy at c7672bb). An admitted origin: as many as the
    // view may hold, VIEW_MAX_URLS per render (the reviewers' 6500 are refused whole now), served by the test, and by the
    // e2e server itself (loopback http:, which WebKit upgrades to https: and then fails: its numbers are a failed load's).
    for (const [name, prefix, config, perRender] of [
        ['a refused source', 'https://r.example/', {}, 6500],
        ['an admitted origin', 'https://a.example/', { origins: { images: ['https://a.example'] } }, VIEW_MAX_URLS],
        ['an admitted loopback origin', `${ORIGIN}/test/e2e/pixel.png?`, { origins: { images: [ORIGIN] } }, VIEW_MAX_URLS],
    ] as const) {
        test(`${name}: a flood of renders of ${perRender} <img> leaves the host page about its share`, async ({ sandbox, page, browserName }) => {
            test.setTimeout(90000);
            await page.route('https://a.example/**', route => route.fulfill({ body: PNG, contentType: 'image/png' }));
            await mountEntry(sandbox, imageFlood(prefix, perRender), config);
            await page.waitForTimeout(300);
            const idle = await countTicks(page, 8000);
            await sandbox.run('flood()');
            await page.waitForTimeout(1000);
            const loaded = await countTicks(page, 8000);
            console.log(`MEASURED ${browserName} M-2 ${name}, renders of ${perRender} <img>: host ticks in 8 s: idle ${idle}, under the flood ${loaded} (${Math.round((1 - loaded / idle) * 100)}% busy)`);
            expect(loaded).toBeGreaterThan(idle * 0.7);
        });
    }

    test(`the view holds at most VIEW_MAX_URLS (${VIEW_MAX_URLS}) URL-bearing attributes: a render past it is refused whole, and said`, async ({ sandbox, page, browserName }) => {
        await mountEntry(sandbox, `
            sandboxView.render('<div id="a"></div><div id="b"></div>');
            globalThis.fill = (n, into) => sandboxView.render('<img src="x.png">'.repeat(n), into);`);
        await waitInView(page, browserName, `!!document.getElementById('b')`);
        await sandbox.run(`fill(${VIEW_MAX_URLS - 1}, 'a'); fill(1, 'b')`);
        await waitInView(page, browserName, `document.querySelectorAll('img').length === ${VIEW_MAX_URLS}`, 15000);
        await sandbox.run(`fill(2, 'b')`); // one past: refused, and #b keeps its one
        await sandbox.waitForLog(`[Sandbox] sandboxView.render: the view refused a render: the view would hold more than ${VIEW_MAX_URLS} URLs (src, srcset, poster, href); nothing of it was applied.`, 15000);
        expect(await inView(page, browserName, `document.querySelectorAll('#b img').length + ' ' + document.querySelectorAll('img').length`)).toBe(`1 ${VIEW_MAX_URLS}`);
        await sandbox.run(`fill(1, 'a')`); // replacing #a frees its URLs: room again
        await waitInView(page, browserName, `document.querySelectorAll('#a img').length === 1`, 15000);
        await sandbox.run(`fill(2, 'b')`);
        await waitInView(page, browserName, `document.querySelectorAll('#b img').length === 2`, 15000);
    });

    test(`the view takes at most VIEW_URLS_PER_SECOND (${VIEW_URLS_PER_SECOND}) URL-bearing attributes per second: the operation after a render past it waits`, async ({ sandbox, page, browserName }) => {
        await mountEntry(sandbox, `
            sandboxView.render('<div id="a"></div><p id="b">0</p>');
            globalThis.burst = (n) => { sandboxView.render('<img src="x.png">'.repeat(n), 'a'); sandboxView.text('b', String(n)); };`);
        await waitInView(page, browserName, `!!document.getElementById('b')`);
        const delays: number[] = [];
        // within the budget: the text after the render applies at once; twice the budget: it waits about a second
        for (const n of [1, 2 * VIEW_URLS_PER_SECOND]) {
            await page.waitForTimeout(2500); // the budget refills
            const started = Date.now();
            await sandbox.run(`burst(${n})`);
            await waitInView(page, browserName, `document.getElementById('b').textContent === '${n}'`, 15000);
            delays.push(Date.now() - started);
        }
        console.log(`MEASURED ${browserName} M-2 rate: the operation after a render of 1 URL applied after ${delays[0]} ms, after one of ${2 * VIEW_URLS_PER_SECOND} after ${delays[1]} ms`);
        expect(delays[0]).toBeLessThan(600);
        expect(delays[1]).toBeGreaterThan(800);
    });
});

// M-6: the default call budget, 1000 calls per second. Measured on every engine (the finding was Firefox's): a guest that
// calls a host method paced at the budget, and one that sends the budget's worth at once every second.
test.describe('M-6: the default call budget leaves the host page its share', () => {
    for (const [name, code] of [
        ['paced', `setInterval(() => { for (let i = 0; i < 5; i++) bridge.call('noop').catch(() => {}); }, 5);`],
        ['in bursts', `setInterval(() => { for (let i = 0; i < 1000; i++) bridge.call('noop').catch(() => {}); }, 1000);`],
    ] as const) {
        test(`${name}`, async ({ sandbox, page, browserName }) => {
            test.setTimeout(60000);
            await mountEntry(sandbox, 'void 0');
            await sandbox.exposeHost('noop', '() => 1');
            await page.waitForTimeout(300);
            const idle = await countTicks(page, 6000);
            await sandbox.run(code);
            await page.waitForTimeout(500);
            const gaps = await page.evaluate(() => new Promise<{ ticks: number; longest: number }>(resolve => {
                let ticks = 0;
                let last = performance.now();
                let longest = 0;
                const timer = setInterval(() => {
                    ticks++;
                    const now = performance.now();
                    longest = Math.max(longest, now - last);
                    last = now;
                }, 10);
                setTimeout(() => { clearInterval(timer); resolve({ ticks, longest: Math.round(longest) }); }, 6000);
            }));
            console.log(`MEASURED ${browserName} M-6 ${name} at the default budget: host ticks in 6 s: idle ${idle}, under the calls ${gaps.ticks} (${Math.round((1 - gaps.ticks / idle) * 100)}% busy), longest gap ${gaps.longest} ms`);
            expect(gaps.ticks).toBeGreaterThan(idle * 0.7);
        });
    }
});
