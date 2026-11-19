import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, firefox, type BrowserContext, type Page } from '@playwright/test';
import { test, expect, HARNESS, pairWithBuild } from './fixture';
import { useRecorder } from './recorder';

/**
 * `links` with the browser's popup blocker on (design 02, I6; step 2.6 of docs/design/05-build-order.md): the tab opens for
 * the user's click on a marked link, and for nothing else the guest can do, on the two engines whose blocker Playwright
 * can switch on. WebKit is skipped: Playwright's WebKit builds have no popup blocker (research 30: its negative control,
 * a `window.open` with no gesture, opened in every run), so a tab there says nothing of Safari's; test/e2e/links.spec.ts
 * holds on WebKit that the host page calls `window.open` for the click on a marked link and for nothing else.
 *
 * The browsers are launched here as research 30 and 33 launch them, so that what Playwright's defaults hide shows:
 *   Chromium  the full build (`channel: 'chromium'`; the headless shell has no blocker), without Playwright's
 *             `--disable-popup-blocking`, in a profile on disk (a press connects to a link's host only there, research 33)
 *   Firefox   Playwright's preferences with the blocker on at its release values (research 30's) and speculative
 *             connections on (Playwright sets them off, which hides a press's connection, research 33)
 * Nothing is evaluated in the host page before the measurement ends: Playwright's evaluate can carry a user gesture,
 * which would open the blocker's 5 seconds itself. The page starts its sandbox from an init script, and says what it did
 * by requests to the recorder's other listener (`blocked`, which no listed URL names); the clicks are real input at fixed
 * coordinates (the harness's element is at 8, 8). Every run is a fresh browser.
 *
 * The listed URLs are the recorder's (`allowed`): a tab that opens is a request there.
 */

const recorder = useRecorder();

// ledger: popup-blocker
test.skip(({ browserName }) => browserName === 'webkit', "Playwright's WebKit has no popup blocker: a tab there would say nothing of Safari's (research 30)");

// Firefox's popup blocker at its release values (research 30, lib.mjs), and speculative connections on (research 33).
const FIREFOX_PREFS = {
    'dom.disable_open_during_load': true,
    'dom.disable_open_click_delay': 1000,
    'dom.popup_maximum': 20,
    'dom.user_activation.transient.timeout': 5000,
    'dom.popup_allowed_events': 'change click dblclick auxclick mouseup pointerup notificationclick reset submit touchend contextmenu',
    'network.http.speculative-parallel-limit': 6,
};

const ORIGIN_X = 8; // the harness's <web-sandbox> (400 × 300) is the body's first child, at the body's margin
const ORIGIN_Y = 8;

/** A fresh browser of the test's engine with its blocker on, on the default build, and its one page. */
async function openBrowser(browserName: string): Promise<{ context: BrowserContext; page: Page; close: () => Promise<void> }> {
    // ledger: popup-blocker
    if (browserName === 'chromium') {
        const profile = mkdtempSync(path.join(tmpdir(), 'links-popup-'));
        const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, ignoreHTTPSErrors: true, ignoreDefaultArgs: ['--disable-popup-blocking'] });
        await pairWithBuild(context, 'default');
        const page = context.pages()[0] ?? await context.newPage();
        return { context, page, close: async () => { await context.close(); rmSync(profile, { recursive: true, force: true }); } };
    }
    const browser = await firefox.launch({ headless: true, firefoxUserPrefs: FIREFOX_PREFS });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    await pairWithBuild(context, 'default');
    const page = await context.newPage();
    return { context, page, close: () => browser.close() };
}

/** What the page's init script is given: the sealed app it starts on its own, and where it reports. */
interface Setup {
    links: string[];
    html: string;
    entry: string;
    report: string;
    /** A `window.open` of the host page's own this long after `ready`, with no gesture: the blocker's negative control. */
    controlAfter?: number;
    control?: string;
    /** A link of the host page's own, under the sandbox, with a real href: research 33's positive control. */
    hostLink?: string;
}

// In the host page only (an init script runs in every frame): once the harness is ready, starts a sealed app with the
// setup's links, and reports to `report` (a no-cors request) when the app is ready, when its entry has rendered, and each
// window.open the host page makes, with what it was given.
function hostPage(setup: Setup) {
    if (window !== window.top || !location.protocol.startsWith('http')) return;
    const report = (what: string) => { fetch(`${setup.report}/${what}`, { mode: 'no-cors', cache: 'no-store' }).catch(() => {}); };
    const open = window.open;
    window.open = function (this: Window, ...args: unknown[]) {
        report(`open?${new URLSearchParams({ url: String(args[0]), target: String(args[1]), features: String(args[2]) })}`);
        return Reflect.apply(open, this, args);
    } as typeof window.open;
    const start = () => {
        if ((window as any).harnessReady !== true) return void setTimeout(start, 20);
        if (setup.hostLink) {
            const link = document.createElement('a');
            link.id = 'host-link';
            link.href = setup.hostLink;
            link.textContent = 'host link';
            link.style.cssText = 'position:absolute;left:8px;top:340px;width:200px;height:40px;display:block;background:#ddd';
            document.body.appendChild(link);
        }
        const element = document.querySelector('web-sandbox') as any;
        element.addEventListener('ready', () => {
            report('ready');
            if (setup.controlAfter !== undefined) setTimeout(() => window.open(setup.control, '_blank', 'noopener,noreferrer'), setup.controlAfter);
        });
        element.start({ html: setup.html, entry: 'main.js', files: { 'main.js': setup.entry } }, { links: setup.links, methods: { rendered: () => { report('rendered'); return true; } } });
    };
    start();
}

const BOX = 'position:absolute;display:block;width:120px;height:40px;margin:0';
const MARKUP = (a: string, unlisted: string) => `<a id="a" href="${a}" style="${BOX};left:10px;top:10px;background:#ccd">listed</a>`
    + `<a id="u" href="${unlisted}" style="${BOX};left:150px;top:10px">unlisted</a>`
    + `<p id="off" style="${BOX};left:150px;top:130px">off</p>`;
// the guest: on a click on #off, within the blocker's 5 seconds, everything it has to ask for its link without the
// user's click on one (focus it, move it, call every name a request could have), then it says so
const ENTRY = (listed: string) => `
    sandboxView.on('click', 'off', async () => {
        sandboxView.set('a', { focus: true });
        sandboxView.render('<a id="a" href=${JSON.stringify(listed)} style="position:absolute;display:block;left:150px;top:130px;width:120px;height:40px">moved</a>', null);
        for (const name of ['sandbox:open', 'sandbox:link', 'open']) { try { await bridge.call(name, 0); } catch {} }
        await bridge.call('rendered');
    });
    setTimeout(() => bridge.call('rendered'), 0);
`;
const AT = { a: [70, 30], u: [210, 30], off: [210, 150] } as const;
const click = (page: Page, spot: keyof typeof AT, options: { button?: 'middle' } = {}) => page.mouse.click(ORIGIN_X + AT[spot][0], ORIGIN_Y + AT[spot][1], options);

/** What the host page reported, in order. */
const reports = () => recorder.paths('blocked').map(entry => decodeURIComponent(entry));
const openReports = () => reports().filter(entry => entry.startsWith('/open?'));
const tabsAt = (prefix: string) => recorder.paths('allowed').filter(entry => entry.startsWith(prefix));

async function started(page: Page, setup: Omit<Setup, 'report'>) {
    await page.addInitScript(hostPage, { ...setup, report: recorder.blocked });
    await page.goto(HARNESS);
    await recorder.waitFor('blocked', '/ready', 15000);
    await recorder.waitFor('blocked', '/rendered', 15000);
}

test.describe('the popup blocker on', () => {
    test.setTimeout(60000);

    test("negative control: the host page's own window.open with no gesture is blocked, so the blocker is on", async ({ browserName }) => {
        const { context, page, close } = await openBrowser(browserName);
        try {
            const tabs: Page[] = [];
            context.on('page', tab => tabs.push(tab));
            await started(page, { links: [], html: MARKUP(`${recorder.allowed}/link/a`, `${recorder.allowed}/unlisted`), entry: ENTRY(`${recorder.allowed}/link/a`), controlAfter: 500, control: `${recorder.allowed}/control` });
            await expect.poll(() => openReports().length, { timeout: 10000 }).toBe(1); // the page did call it
            await page.waitForTimeout(1500);
            expect(tabsAt('/control')).toEqual([]);
            expect(tabs).toEqual([]);
        } finally {
            await close();
        }
    });

    test('the user\'s click on a marked link opens exactly the listed URL in a new tab, with no opener and no referrer', async ({ browserName }) => {
        const A = `${recorder.allowed}/link/a`;
        const { context, page, close } = await openBrowser(browserName);
        try {
            const tabs: Page[] = [];
            context.on('page', tab => tabs.push(tab));
            await started(page, { links: [A], html: MARKUP(A, `${recorder.allowed}/unlisted`), entry: ENTRY(A) });
            await click(page, 'a');
            await recorder.waitFor('allowed', '/link/a');
            await expect.poll(() => tabs.length).toBe(1);
            expect(openReports()).toEqual([`/open?url=${A}&target=_blank&features=noopener,noreferrer`]);
            const hit = recorder.hits.find(entry => entry.server === 'allowed' && entry.path === '/link/a')!;
            expect(hit.headers.referer ?? '').toBe('');
            await tabs[0]!.waitForLoadState('domcontentloaded');
            expect(tabs[0]!.url()).toBe(A);
            expect(await tabs[0]!.evaluate(() => [window.opener, document.referrer])).toEqual([null, '']);
            // one tab a click: a second click is a second tab
            await page.bringToFront();
            await click(page, 'a');
            await expect.poll(() => tabsAt('/link/a').length).toBe(2);
        } finally {
            await close();
        }
    });

    test('nothing else the guest can do opens one: a click on an unlisted link, a middle click on the marked one, a click elsewhere followed by the guest\'s focus, render and calls within the 5 seconds', async ({ browserName }) => {
        const A = `${recorder.allowed}/link/a`;
        const { context, page, close } = await openBrowser(browserName);
        try {
            const tabs: Page[] = [];
            context.on('page', tab => tabs.push(tab));
            await started(page, { links: [A], html: MARKUP(A, `${recorder.allowed}/unlisted`), entry: ENTRY(A) });
            const renders = () => reports().filter(entry => entry === '/rendered').length;
            await click(page, 'u');
            await click(page, 'a', { button: 'middle' });
            const before = renders();
            await click(page, 'off'); // the guest's turn: it asks within the 5 seconds of this click
            await expect.poll(renders, { timeout: 5000 }).toBeGreaterThan(before);
            await page.waitForTimeout(5500); // past the click's activation
            expect(openReports()).toEqual([]);
            expect(recorder.paths('allowed')).toEqual([]);
            expect(tabs.map(tab => tab.url())).toEqual([]);
            // positive control: the user's click on the link the guest moved under #off opens it
            await click(page, 'off');
            await recorder.waitFor('allowed', '/link/a');
            expect(openReports()).toEqual([`/open?url=${A}&target=_blank&features=noopener,noreferrer`]);
        } finally {
            await close();
        }
    });

    test('Enter on the marked link the guest focused, long after any click, opens it: the key is the click', async ({ browserName }) => {
        const A = `${recorder.allowed}/link/a`;
        const { page, close } = await openBrowser(browserName);
        try {
            const entry = `sandboxView.on('click', 'off', () => { sandboxView.set('a', { focus: true }); bridge.call('rendered'); }); setTimeout(() => bridge.call('rendered'), 0);`;
            await started(page, { links: [A], html: MARKUP(A, `${recorder.allowed}/unlisted`), entry });
            await click(page, 'off'); // gives the view the user's focus; the guest moves it to the link
            await expect.poll(() => reports().filter(report => report === '/rendered').length).toBe(2);
            await page.waitForTimeout(5500); // the click's activation is over
            expect(openReports()).toEqual([]);
            await page.keyboard.press('Enter');
            await recorder.waitFor('allowed', '/link/a');
            expect(openReports()).toEqual([`/open?url=${A}&target=_blank&features=noopener,noreferrer`]);
        } finally {
            await close();
        }
    });

    // Research 33: a real href in the view reached the listed host before the click (Chromium: a press connects; Firefox:
    // a press connects, and a press held one second fetches the page). The marked link's href is the inert one, so a press
    // held past that second, released off the link (no click), reaches nothing; the host page's own link with a real href,
    // pressed the same way in the same browser, does (the positive control: what this configuration shows).
    test('a press on a marked link held past a second, released off it, reaches nothing of the listed host; the same press on a real link does', async ({ browserName }) => {
        const A = `${recorder.allowed}/link/a`;
        const { context, page, close } = await openBrowser(browserName);
        try {
            const tabs: Page[] = [];
            context.on('page', tab => tabs.push(tab));
            await started(page, { links: [A], html: MARKUP(A, `${recorder.blocked}/unlisted`), entry: ENTRY(A), hostLink: `${recorder.allowed}/control` });
            const press = async (x: number, y: number) => {
                await page.mouse.move(x, y);
                await page.mouse.down();
                await page.waitForTimeout(1500);
                await page.mouse.move(ORIGIN_X + 390, ORIGIN_Y + 290, { steps: 4 });
                await page.mouse.up();
            };
            await press(ORIGIN_X + AT.a[0], ORIGIN_Y + AT.a[1]);
            await page.waitForTimeout(1500);
            expect(recorder.connections.allowed).toBe(0);
            expect(recorder.paths('allowed')).toEqual([]);
            expect(openReports()).toEqual([]);
            // positive control: the host page's link with a real href, pressed the same way
            await press(ORIGIN_X + 100, 360);
            await expect.poll(() => recorder.connections.allowed, { timeout: 5000 }).toBeGreaterThan(0);
            expect(tabs).toEqual([]);
        } finally {
            await close();
        }
    });
});
