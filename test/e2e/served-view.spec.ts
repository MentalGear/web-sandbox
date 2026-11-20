import type { BrowserContext, Frame, Page } from '@playwright/test';
import { test, expect, ORIGIN, OFFSITE_ORIGIN, HARNESS } from './fixture';
import { pageDocumentUrl } from './library';
import { E2E_PORT } from './server';
import { clickInSandbox, inFrames, inView, waitInView } from './strict-view';
import { reasonText } from '@src/lib/reasons';
import { SEALED_VIEW_FLAGS } from '@src/lib/sealed-document';

/**
 * Sealed mode's view is the served file (design 03; step 3.2 of design 05), on every engine:
 *
 *  1. The twelve ways of opening the shipped file (research 28's, as research 31 ran them with the design's flags), with
 *     the bytes the build wrote: the view (C) is built only where the file (F) is framed sandboxed, opaque, by whatever
 *     page (I14); wherever F holds an origin's authority, F has run its guard and nothing else, and C does not exist, so
 *     no guest content can ever run with that authority (I11). Where C exists it is opaque and reaches nothing of an
 *     origin's, and its one message, the announcement, goes to whatever page framed the file.
 *  2. The element frames the file as the design draws it: in its shadow root, at the registered documentUrl, with the
 *     flags of the app's grants (C's static attribute narrowed by them), no referrer, no document of its own.
 *  3. A `<base>` in the host page moves neither the frame's URL nor anything in the view.
 *  4. A cross-site page that frames the host page finds no frame of the element's to navigate or to message: the frame
 *     in the shadow root is not in the page's `window.frames`, and the host page hears an announcement only from the
 *     first frame of the element's own frame (I3, I13).
 *  5. One load of the frame per build: a reset() loads it again, nothing else does, and a second load ends the build.
 *  6. A guest form's `submit` in the served view: the view cancels it, so F's `form-action 'none'` refuses nothing, the
 *     view stays the document it was, and the guest is told of the submit.
 *  7. C fills F, and auto-resize works through F (C's size in F, design 03).
 */

const FILE = `${ORIGIN}${pageDocumentUrl('default')}`;
const SAME_SITE = `http://localhost:${E2E_PORT + 1}`; // another origin of the file's site: served by the routes below
const CROSS_SITE = OFFSITE_ORIGIN; // another site: 127.0.0.1, the e2e server's other name
const VIEW_FLAGS = 'allow-scripts allow-forms';

const html = (body: string) => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>embedder</title></head><body>${body}</body></html>`;
const escaped = (text: string) => text.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');

/**
 * The embedders of the twelve ways, as routes of the context: `/__ways/embed?attrs=…` frames the file, `/__ways/opener`
 * opens it, `/__ways/sandboxed-opener` opens it from a sandboxed frame (a popup inherits the sandbox). Every embedder
 * records the messages its window receives (`window.heard`).
 */
async function routeEmbedders(context: BrowserContext) {
    await allowLocalNetwork(context);
    const RECORD = `<script>window.heard = []; addEventListener('message', (e) => window.heard.push(JSON.stringify(e.data)));</script>`;
    for (const origin of [ORIGIN, SAME_SITE, CROSS_SITE]) {
        await context.route(`${origin}/__ways/**`, (route) => {
            const url = new URL(route.request().url());
            if (url.pathname === '/__ways/embed') return route.fulfill({ contentType: 'text/html', body: html(`${RECORD}<iframe ${url.searchParams.get('attrs') ?? ''} src="${FILE}"></iframe>`) });
            if (url.pathname === '/__ways/opener') return route.fulfill({ contentType: 'text/html', body: html(RECORD) });
            if (url.pathname === '/__ways/sandboxed-opener') return route.fulfill({ contentType: 'text/html', body: html(`${RECORD}<iframe sandbox="allow-scripts allow-forms allow-popups" srcdoc="${escaped('<script>window.go = (u) => { window.w = window.open(u); };</script>')}"></iframe>`) });
            return route.fulfill({ status: 404, body: '' });
        });
    }
}

/**
 * A page these routes fulfil has no address of the loopback's, so Chromium's local network access checks would refuse its
 * frame of the e2e server's localhost (`ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`): the context is granted that access, as
 * a page served from the machine itself has it. Firefox and WebKit have no such permission and no such check.
 */
async function allowLocalNetwork(context: BrowserContext) {
    if (context.browser()?.browserType().name() === 'chromium') await context.grantPermissions(['local-network-access']);
}

/** What a document of the file holds and reaches, read in F: its scripts, its frames, its origin. */
const READ_FILE = `({ origin: self.origin, scripts: document.scripts.length, frames: document.querySelectorAll('iframe').length, children: frames.length })`;
/** What C is, read in C: its origin, and each of an origin's stores and its parents' documents, which must all refuse it. */
const READ_VIEW = `(() => {
    const tries = {};
    const attempt = (name, run) => { try { const value = run(); tries[name] = value === undefined || value === null || value === '' ? 'empty' : 'reached'; } catch (e) { tries[name] = 'refused'; } };
    attempt('localStorage', () => localStorage.length + 1);
    attempt('sessionStorage', () => sessionStorage.length + 1);
    attempt('cookie', () => { document.cookie = 'ways=1'; return document.cookie; });
    attempt('indexedDB', () => indexedDB.open('ways'));
    attempt('parentDocument', () => parent.document.title + '.');
    attempt('topDocument', () => top.document.title + '.');
    return { origin: self.origin, url: location.href, base: document.baseURI, scripts: document.scripts.length, tries };
})()`;

interface WayResult { c: boolean; file: { origin: string; scripts: number; frames: number; children: number } | null; view: any; heard: string[] }

/** F's frame in `page`, by its URL; C is its first child frame. */
const fileFrameOf = (page: Page): Frame | undefined => page.frames().find(frame => frame.url() === FILE);

async function readWay(page: Page, file: Frame | undefined, embedder: Page | Frame): Promise<WayResult> {
    await page.waitForTimeout(800); // the guard runs as F parses; C, where it exists, announces itself at once
    const fileValue = file ? await file.evaluate(READ_FILE).catch(() => null) as WayResult['file'] : null;
    const child = file?.childFrames()[0];
    const view = child ? await child.evaluate(READ_VIEW).catch((error) => `no context: ${String(error).slice(0, 80)}`) : null;
    const heard = await embedder.evaluate(() => (window as any).heard ?? []).catch(() => []) as string[];
    return { c: child !== undefined, file: fileValue, view, heard };
}

/** Each way: its name, and how to open the file in `page` (returns F's frame and the window that would hear C). */
type Way = { name: string; framedSandboxed: boolean; open: (page: Page) => Promise<{ file: Frame | undefined; embedder: Page | Frame; pageOfFile: Page }> };
const framed = (name: string, origin: string, attrs: string, framedSandboxed: boolean): Way => ({
    name, framedSandboxed,
    open: async (page) => {
        await page.goto(`${origin}/__ways/embed?attrs=${encodeURIComponent(attrs)}`, { waitUntil: 'commit' });
        await expect.poll(() => fileFrameOf(page) !== undefined, { timeout: 5000 }).toBe(true);
        return { file: fileFrameOf(page), embedder: page, pageOfFile: page };
    },
});
const WAYS: Way[] = [
    { name: 'top-level navigation', framedSandboxed: false, open: async (page) => { await page.goto(FILE, { waitUntil: 'commit' }); return { file: page.mainFrame(), embedder: page, pageOfFile: page }; } },
    {
        name: 'a popup opened by a cross-site page', framedSandboxed: false,
        open: async (page) => {
            await page.goto(`${CROSS_SITE}/__ways/opener`);
            const [popup] = await Promise.all([page.context().waitForEvent('page'), page.evaluate((url) => { (window as any).w = window.open(url); }, FILE)]);
            await popup.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
            return { file: popup.mainFrame(), embedder: page, pageOfFile: popup };
        },
    },
    framed(`framed by the file's origin, sandbox="${VIEW_FLAGS}"`, ORIGIN, `sandbox="${VIEW_FLAGS}"`, true),
    framed(`framed by the file's origin, sandbox="${VIEW_FLAGS}", referrerpolicy="no-referrer" (as the element frames it)`, ORIGIN, `sandbox="${VIEW_FLAGS}" referrerpolicy="no-referrer"`, true),
    framed("framed by the file's origin, no sandbox attribute", ORIGIN, '', false),
    framed(`framed by the file's origin, sandbox="${VIEW_FLAGS} allow-same-origin"`, ORIGIN, `sandbox="${VIEW_FLAGS} allow-same-origin"`, false),
    framed('framed by another origin of its site, no sandbox attribute', SAME_SITE, '', false),
    framed('framed by another site, no sandbox attribute', CROSS_SITE, '', false),
    framed(`framed by another site, sandbox="${VIEW_FLAGS} allow-same-origin"`, CROSS_SITE, `sandbox="${VIEW_FLAGS} allow-same-origin"`, false),
    framed(`framed by another site, sandbox="${VIEW_FLAGS}"`, CROSS_SITE, `sandbox="${VIEW_FLAGS}"`, true),
    framed(`framed by another site, sandbox="${VIEW_FLAGS}", referrerpolicy="no-referrer"`, CROSS_SITE, `sandbox="${VIEW_FLAGS}" referrerpolicy="no-referrer"`, true),
    {
        name: 'a popup opened from a cross-site sandboxed frame (opaque and top-level)', framedSandboxed: false,
        open: async (page) => {
            await page.goto(`${CROSS_SITE}/__ways/sandboxed-opener`);
            const opener = page.frames().find(frame => frame !== page.mainFrame())!;
            const [popup] = await Promise.all([page.context().waitForEvent('page'), opener.evaluate((url) => (window as any).go(url), FILE)]);
            await popup.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
            return { file: popup.mainFrame(), embedder: opener, pageOfFile: popup };
        },
    },
];

test.describe('1. the twelve ways of opening the shipped file (I11, I14)', () => {
    test('the ways are research 28\'s twelve, and four of them frame the file sandboxed without allow-same-origin', () => {
        expect(WAYS).toHaveLength(12);
        expect(WAYS.filter(way => way.framedSandboxed)).toHaveLength(4);
        expect(SEALED_VIEW_FLAGS).not.toContain('allow-same-origin');
    });

    for (const way of WAYS) {
        test(way.name, async ({ context }) => {
            await routeEmbedders(context);
            const page = await context.newPage();
            const { file, embedder, pageOfFile } = await way.open(page);
            const result = await readWay(pageOfFile, file, embedder);
            if (way.framedSandboxed) {
                // the view exists, opaque, and reaches nothing of an origin's: every store and both parents refuse it
                expect(result.c).toBe(true);
                expect(result.file).toEqual({ origin: 'null', scripts: 1, frames: 1, children: 1 });
                expect(result.view.origin).toBe('null');
                expect([result.view.url, result.view.base, result.view.scripts]).toEqual(['about:srcdoc', 'about:blank', 1]);
                for (const [name, outcome] of Object.entries(result.view.tries)) expect(outcome, name).not.toBe('reached');
                // its one message goes to whatever page framed the file: the announcement, with nothing in it
                expect(result.heard).toEqual([JSON.stringify({ type: 'VIEW_ANNOUNCE' })]);
                return;
            }
            // the guard stopped F: no view was built, and F ran nothing but the guard, whatever origin it holds
            expect(result.c).toBe(false);
            expect(result.view).toBeNull();
            if (result.file) expect([result.file.scripts, result.file.frames, result.file.children], JSON.stringify(result.file)).toEqual([1, 0, 0]);
            expect(result.heard).toEqual([]);
        });
    }
});

test.describe('2. the element frames the file as the design draws it', () => {
    test("in its shadow root, at the registered documentUrl, with the flags of the app's grants, no referrer and no document of its own", async ({ sandbox, page, browserName }) => {
        expect(await sandbox.mount({ mode: 'sealed', capabilities: ['allow-orientation-lock'] })).toBe('ready');
        const frame = await page.evaluate(() => {
            const iframe = (document.querySelector('web-sandbox') as any).shadowRoot.querySelector('iframe') as HTMLIFrameElement;
            const attributes: Record<string, string> = {};
            for (const name of iframe.getAttributeNames()) attributes[name] = iframe.getAttribute(name)!;
            return { attributes, frames: window.frames.length };
        });
        expect(frame.attributes).toEqual({ sandbox: 'allow-scripts allow-forms allow-orientation-lock', referrerpolicy: 'no-referrer', credentialless: '', style: frame.attributes.style, src: FILE });
        expect(frame.frames).toBe(0); // not in the page's window.frames
        // C's static attribute is the most the library grants; F's narrows it to the grants
        expect(await inView(page, browserName, 'document.referrer')).toBe('');
    });
});

test.describe('3. a <base> in the host page changes nothing', () => {
    test("the frame's URL is resolved against the document's own URL, and the view is the same", async ({ page, browserName }) => {
        // a host page whose <base> points at another site, as injected markup could add one before the element is defined
        await page.route(`${ORIGIN}/__served-view/base.html`, route => route.fulfill({
            contentType: 'text/html',
            body: `<!DOCTYPE html><html><head><meta charset="utf-8"><base href="${CROSS_SITE}/elsewhere/"><script type="module">
                import { loadLibrary } from '${ORIGIN}/test/e2e/library.ts';
                const { defineWebSandbox } = await loadLibrary();
                defineWebSandbox({ documentUrl: '../dist/sealed-document.html' });
                const el = document.createElement('web-sandbox');
                el.style.cssText = 'display:block;width:400px;height:300px';
                el.addEventListener('ready', () => { window.outcome = 'ready'; }, { once: true });
                el.addEventListener('terminated', (e) => { window.outcome = 'terminated: ' + e.detail.reason; }, { once: true });
                el.start({ html: '<p id="hello">hello</p>' });
                document.body.append(el);
            </script></head><body></body></html>`,
        }));
        await page.goto(`${ORIGIN}/__served-view/base.html`);
        await page.waitForFunction(() => (window as any).outcome !== undefined);
        expect(await page.evaluate(() => [(window as any).outcome, document.baseURI])).toEqual(['ready', `${CROSS_SITE}/elsewhere/`]);
        const src = await page.evaluate(() => (document.querySelector('web-sandbox') as any).shadowRoot.querySelector('iframe').getAttribute('src'));
        expect(src).toBe(`${ORIGIN}/dist/sealed-document.html`);
        expect(page.frames().map(frame => frame.url())).toContain(`${ORIGIN}/dist/sealed-document.html`);
        expect(page.frames().some(frame => frame.url().startsWith(CROSS_SITE))).toBe(false);
        expect(await waitInView(page, browserName, `document.getElementById('hello') && [location.href, document.baseURI].join(' ')`)).toBe('about:srcdoc about:blank');
    });
});

test.describe('4. a cross-site page that frames the host page finds no frame of the element\'s (I3, I13)', () => {
    test('it can neither reach the frame through window.frames nor announce itself to the host page', async ({ context, browserName }) => {
        await allowLocalNetwork(context);
        await context.route(`${CROSS_SITE}/__served-view/framer.html`, route => route.fulfill({
            contentType: 'text/html', body: html(`<iframe src="${HARNESS}?framed" style="width:600px;height:500px"></iframe>`),
        }));
        const page = await context.newPage();
        await page.goto(`${CROSS_SITE}/__served-view/framer.html`);
        const host = page.frames().find(frame => frame.url().startsWith(HARNESS))!;
        await host.waitForFunction(() => (window as any).harnessReady === true);
        // a sealed app in the framed host page, started as an embedder starts it
        expect(await host.evaluate(() => new Promise<string>(resolve => {
            const el = document.createElement('web-sandbox') as any;
            el.id = 'framed';
            el.addEventListener('ready', () => resolve('ready'), { once: true });
            el.addEventListener('terminated', (e: any) => resolve(`terminated: ${e.detail.reason}`), { once: true });
            el.start({ html: '<p id="hello">hello</p>' });
            document.body.append(el);
        }))).toBe('ready');
        const reach = () => page.evaluate(() => {
            const hostWindow = frames[0]!;
            let first: string;
            // an index a cross-origin window does not have reads undefined (Chromium) or throws (Firefox, WebKit): no window either way
            try { first = hostWindow[0] === undefined ? 'no window' : 'a window'; } catch { first = 'no window'; }
            return { length: hostWindow.length, first };
        });
        expect(await reach()).toEqual({ length: 0, first: 'no window' });
        // the framing page's own announcement is not the view's: the host page ignores it, and the sandbox goes on
        await page.evaluate(() => frames[0]!.postMessage({ type: 'VIEW_ANNOUNCE' }, '*'));
        await page.waitForTimeout(300);
        expect(await host.evaluate(() => [(document.getElementById('framed') as any).state, ((window as any).sandboxTerminations ?? []).length])).toEqual(['ready', 0]);
        // positive control: a frame in the host page's light DOM is in its window.frames, which the framing page reaches
        await host.evaluate(() => { const plain = document.createElement('iframe'); plain.src = 'about:blank'; document.body.append(plain); });
        expect(await reach()).toEqual({ length: 1, first: 'a window' });
        expect(browserName).toBeTruthy();
    });
});

test.describe('5. one load of the frame per build', () => {
    test('a reset() loads the file again, nothing else does, and a second load of the frame ends the build', async ({ sandbox, page, browserName }) => {
        // the frame's loads: its navigations of the file (the check of the file, the host page's own request for it, is
        // not a load of the frame: test/e2e/served-file-check.spec.ts)
        const loads: string[] = [];
        page.on('request', request => { if (request.url() === FILE && request.isNavigationRequest()) loads.push(request.url()); });
        await sandbox.registerFiles({ 'main.js': `sandboxView.render('<p id="n">0</p>', 'root'); let n = 0; bridge.expose('add', () => { n++; sandboxView.text('n', String(n)); return n; });` });
        expect(await sandbox.mount({ mode: 'sealed', entry: 'main.js', autoResize: true })).toBe('ready');
        expect(loads).toHaveLength(1);
        for (let i = 1; i <= 3; i++) expect(await sandbox.call('add')).toBe(i);
        await page.waitForTimeout(200);
        expect(loads).toHaveLength(1);
        expect(await sandbox.reset()).toBe('ready');
        expect(loads).toHaveLength(2);
        // the frame navigated again: its second load ends the build, or the view the new document holds, which announces
        // itself a second time, ends it first (Firefox): either way at once, and with the reason that names it
        await page.evaluate(() => { const frame = (document.querySelector('web-sandbox') as any).shadowRoot.querySelector('iframe'); frame.src = frame.src; });
        await expect.poll(() => sandbox.state()).toBe('terminated');
        const reasons = (await sandbox.terminations()).map(t => t.reason);
        expect(reasons).toHaveLength(1);
        expect([reasonText('secondLoad'), reasonText('secondAnnouncement')]).toContain(reasons[0]);
        console.log(`MEASURED ${browserName} the served frame's second load ends the build with: ${reasons[0]}`);
        expect(loads).toHaveLength(3); // the second load was made, and nothing answered it with a port
    });
});

test.describe("6. a guest form's submit in the served view", () => {
    test('the view cancels it and tells the guest; F refuses no form action, and the view stays the document it was', async ({ sandbox, page, browserName }) => {
        await sandbox.registerFiles({ 'main.js': `
            const seen = [];
            sandboxView.render('<form id="f" action="https://elsewhere.example/" method="post"><input name="q" value="typed"><button id="go">go</button></form><p id="marker">here</p>', 'root');
            sandboxView.on('submit', null, (event) => seen.push(event.target.id));
            bridge.expose('submits', () => seen);
        ` });
        expect(await sandbox.mount({ mode: 'sealed', entry: 'main.js', html: '<div id="root"></div>' })).toBe('ready');
        const box = await waitInView<{ x: number; y: number }>(page, browserName, `(() => { const b = document.getElementById('go'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
        await clickInSandbox(page, box.x, box.y);
        await expect.poll(() => sandbox.call('submits'), { timeout: 5000 }).toEqual(['f']);
        expect(await inView(page, browserName, `[location.href, !!document.getElementById('marker'), document.forms.length]`)).toEqual(['about:srcdoc', true, 1]);
        expect(await sandbox.state()).toBe('ready');
        const formViolations = await page.evaluate(() => ((window as any).sandboxViolations ?? []).filter((v: any) => v.directive === 'form-action'));
        expect(formViolations).toEqual([]);
        const file = (await inFrames(page, browserName, 'location.href', path => path === 'main/wrapper')).find(f => f.path === 'main/wrapper');
        expect(file?.value).toBe(FILE);
    });
});

test.describe("7. C's size in F", () => {
    test('the view fills the frame, and auto-resize sizes the element through it', async ({ sandbox, page, browserName }) => {
        expect(await sandbox.mount({ mode: 'sealed', html: '<p>short</p>' })).toBe('ready');
        const element = await page.evaluate(() => { const r = document.querySelector('web-sandbox')!.getBoundingClientRect(); return { width: Math.round(r.width), height: Math.round(r.height) }; });
        expect(element).toEqual({ width: 400, height: 300 }); // the harness's size
        expect(await waitInView(page, browserName, `innerWidth > 0 && [innerWidth, innerHeight].join('x')`)).toBe('400x300');
        await sandbox.registerFiles({ 'main.js': `sandboxView.render('<div style="height: 640px">tall</div>', 'root');` });
        expect(await sandbox.mount({ mode: 'sealed', entry: 'main.js', autoResize: true })).toBe('ready');
        await expect.poll(() => page.evaluate(() => Math.round(document.querySelector('web-sandbox')!.getBoundingClientRect().height)), { timeout: 5000 }).toBeGreaterThanOrEqual(640);
        expect(await waitInView(page, browserName, `innerHeight >= 640 && innerHeight`)).toBeGreaterThanOrEqual(640);
    });
});
