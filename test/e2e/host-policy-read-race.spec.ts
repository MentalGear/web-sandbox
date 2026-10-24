import type { Page } from '@playwright/test';
import { test, expect, ORIGIN } from './fixture';
import { useRecorder } from './recorder';

/**
 * The read of the host page's policy under the embedder's DOM changes (S74, class L; src/lib/host-csp.ts): its frame is
 * held in the shadow root of the first element that asked, and other elements' builds wait on it. Whatever happens to
 * that frame while it reads (its element moved by a keyed reorder, removed by an unmount, or removed before its frame's
 * load, which Firefox fires late), a build that waited is narrowed by the page's policy, read by a frame that stayed in
 * the document, or by nothing (every connect origin dropped, with a warning): never by an absent answer. The page's
 * policy here is `connect-src 'self'`, which refuses the recorder's origin O on every engine as the library reads it; in
 * every case the guest's policy has no O, a "dropped" warning was given, the guest's `fetch()` is the request gate's
 * refusal, `sandboxFetch()` is FETCH_NOT_ALLOWED, and nothing reaches the listener. The positive control: a page whose
 * policy names O, under the same reorder, narrows nothing and the guest's request arrives.
 */

// ledger: connect-src (the outcome is the same on every engine under the embedder's DOM changes too)
const recorder = useRecorder();

test.use({ ignoreHTTPSErrors: true });

async function openHost(page: Page, csp: string, warnings: string[]) {
    page.on('console', message => { if (message.type() === 'warning' && /^\[Sandbox\] (origins\.connect|fetchBridge\.allow) dropped|could not be read/.test(message.text())) warnings.push(message.text()); });
    await page.goto(`${ORIGIN}/__host-policy?${new URLSearchParams({ csp })}`);
    await page.waitForFunction(() => (window as any).harnessReady === true);
    await page.evaluate(() => {
        const w = window as any;
        w.make = (id: string, config: Record<string, unknown>) => {
            const el = document.createElement('web-sandbox') as any;
            el.id = id;
            el.style.display = 'block';
            el.style.height = '40px';
            el.registerFiles({ 'main.js': 'void 0' });
            el.setConfig({ mode: 'strict', entry: 'main.js', scriptUnsafe: true, ...config });
            return el;
        };
        w.settled = (el: any) => new Promise<string>(resolve => {
            if (el.state === 'ready') return resolve('ready');
            el.addEventListener('ready', () => resolve('ready'), { once: true });
            el.addEventListener('terminated', (event: any) => resolve(`terminated ${event.detail.reason}`), { once: true });
        });
        w.guest = (el: any, code: string) => new Promise<string>(resolve => {
            const on = (event: any) => {
                const line = (event.detail?.args || []).map(String).join(' ');
                if (!line.startsWith('RACE ')) return;
                el.removeEventListener('sandbox-log', on);
                resolve(line.slice(5));
            };
            el.addEventListener('sandbox-log', on);
            el.execute(code);
            setTimeout(() => resolve('timeout'), 8000);
        });
        // what a build made of O: its policy's connect-src, and what the guest's request came to
        w.outcome = async (el: any, url: string, bridge: boolean) => {
            const state = await w.settled(el);
            const srcdoc = el.shadowRoot.querySelector('iframe')?.srcdoc ?? '';
            const connect = (/connect-src ([^;"]*)/.exec(srcdoc) || [])[1] || '';
            const code = bridge
                ? `sandboxFetch(${JSON.stringify(url)}).then(r => console.log('RACE ok ' + r.status), e => console.log('RACE ' + e.code))`
                : `fetch(${JSON.stringify(url)}, { cache: 'no-store' }).then(() => console.log('RACE ok'), e => console.log('RACE ' + e.name + ': ' + e.message))`;
            return { id: el.id, state, listsO: connect.includes(url.slice(0, url.indexOf('/', 8))), request: state === 'ready' ? await w.guest(el, code) : 'n/a' };
        };
    });
}

type Outcome = { id: string; state: string; listsO: boolean; request: string };
const frame = 'await new Promise(r => requestAnimationFrame(() => r(0)));';
const later = (ms: number) => `await new Promise(r => setTimeout(r, ${ms}));`;

// Each scenario returns the outcomes of the builds that waited on a read whose frame the DOM change took away.
const SCENARIOS: Record<string, string> = {
    // a keyed list reorder one frame after the list rendered: the first (the reader) is moved behind the second
    'keyed reorder one frame later': `const list = document.createElement('div'); document.body.append(list);
        const a = make('a', { origins: { connect: [O] } }), b = make('b', { origins: { connect: [O] } });
        list.append(a, b); ${frame} list.append(a);
        return [await outcome(a, O + '/race-reorder-a'), await outcome(b, O + '/race-reorder-b')];`,
    // the reader moved a few ms after it was inserted (a framework's reparenting)
    'the reader moved 5 ms later': `const a = make('a', { origins: { connect: [O] } }); document.body.append(a); ${later(5)} document.body.prepend(a);
        return [await outcome(a, O + '/race-move-5')];`,
    'the reader moved 30 ms later': `const a = make('a', { origins: { connect: [O] } }); document.body.append(a); ${later(30)} document.body.prepend(a);
        return [await outcome(a, O + '/race-move-30')];`,
    // a sibling that started the read unmounted one frame later (a closed tab, a route change)
    'the reading sibling unmounted one frame later': `const a = make('a', { origins: { connect: [O] } }), b = make('b', { origins: { connect: [O] } });
        document.body.append(a, b); ${frame} a.remove();
        return [await outcome(b, O + '/race-unmount-b')];`,
    // the same in the task that mounted both (a render that mounts and discards)
    'the reading sibling unmounted in the same task': `const a = make('a', { origins: { connect: [O] } }), b = make('b', { origins: { connect: [O] } });
        document.body.append(a, b); a.remove();
        return [await outcome(b, O + '/race-unmount-sync-b')];`,
    // the reader removed before its frame loaded (Firefox loads it a task later), then unrelated sandboxes past the read's timeout
    'removed before the frame loaded, later sandboxes': `const a = make('a', { origins: { connect: [O] } }); document.body.append(a); await Promise.resolve(); a.remove();
        ${later(2300)}
        const c = make('c', { origins: { connect: [O] } }); document.body.append(c);
        const first = await outcome(c, O + '/race-later-c');
        const d = make('d', { origins: { connect: [O] } }); document.body.append(d);
        return [first, await outcome(d, O + '/race-later-d')];`,
    // the bridge: the reader, listing only a bridge origin, moved one frame after a reorder
    'the bridge, its element reordered one frame later': `const list = document.createElement('div'); document.body.append(list);
        const a = make('a', { fetchBridge: { allow: [O] } }), b = make('b', {});
        list.append(a, b); ${frame} list.append(a);
        return [await outcome(a, O + '/race-bridge', true)];`,
};

async function run(page: Page, body: string): Promise<Outcome[]> {
    const fn = new Function('O', `const { make, outcome } = window; return (async () => { ${body} })();`);
    return page.evaluate(`(${fn.toString()})(${JSON.stringify(recorder.allowed)})`) as Promise<Outcome[]>;
}

for (const [name, body] of Object.entries(SCENARIOS)) {
    test(`${name}: the build that waited is narrowed by the page's policy, and nothing reaches the listener`, async ({ page }) => {
        test.setTimeout(45_000);
        const warnings: string[] = [];
        await openHost(page, "connect-src 'self'", warnings);
        const outcomes = await run(page, body);
        await page.waitForTimeout(300);
        expect(outcomes.length).toBeGreaterThan(0);
        for (const outcome of outcomes) {
            expect(outcome.state, outcome.id).toBe('ready');
            expect(outcome.listsO, `${outcome.id}: the guest's policy does not list O`).toBe(false);
            if (name.startsWith('the bridge')) expect(outcome.request, outcome.id).toBe('FETCH_NOT_ALLOWED');
            else expect(outcome.request, `${outcome.id}: the request gate refuses`).toMatch(/^TypeError: .*refused by the sandbox/);
        }
        expect(warnings.filter(text => / dropped /.test(text)).length, 'a dropped warning').toBeGreaterThan(0);
        expect(warnings.filter(text => text.includes('could not be read')), 'a removal is not cached as an unreadable policy').toEqual([]);
        expect(recorder.paths('allowed').filter(path => path.startsWith('/race-')), 'nothing reached the listener').toEqual([]);
    });
}

test("positive control: a page whose policy names O, under the same reorder, keeps O and the guest's request arrives", async ({ page }) => {
    const warnings: string[] = [];
    await openHost(page, `connect-src 'self' ${recorder.allowed}`, warnings);
    const outcomes = await run(page, SCENARIOS['keyed reorder one frame later']!);
    for (const outcome of outcomes) {
        expect(outcome.state, outcome.id).toBe('ready');
        expect(outcome.listsO, outcome.id).toBe(true);
        expect(outcome.request, outcome.id).toBe('ok');
    }
    expect(warnings).toEqual([]);
    await recorder.waitFor('allowed', '/race-reorder-a');
    await recorder.waitFor('allowed', '/race-reorder-b');
});
