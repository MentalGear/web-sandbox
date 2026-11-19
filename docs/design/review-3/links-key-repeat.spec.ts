import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, firefox, type BrowserContext, type Page } from '@playwright/test';
import { test, expect, HARNESS, pairWithBuild } from '../../../test/e2e/fixture';
import { useRecorder } from '../../../test/e2e/recorder';

/**
 * Review 3, probe 4 (I6): how many tabs one held key opens. The guest focuses its marked link (sandboxView.set focus,
 * after one click of the user's elsewhere in the view), the click's activation runs out, and the user then holds Enter
 * (a keydown, nine auto-repeated keydowns, a keyup: what a held key sends). Each repeated keydown on a focused link is a
 * trusted click on it where the engine activates links on repeats, and each click is one VIEW_LINK and one window.open.
 *
 * The browsers are launched as test/e2e/links-popup-blocker.spec.ts launches them (its setup copied: that file is a spec
 * and cannot be imported), with the popup blocker on. WebKit is skipped for the same reason.
 *
 * Run: PLAYWRIGHT_BROWSERS_PATH=/home/user/.cache/pw-project flock /home/user/.cache/web-sandbox-e2e.lock \
 *        bunx playwright test -c docs/design/review-3/playwright.config.ts --project=chromium --project=firefox --trace off
 */

const recorder = useRecorder();
test.skip(({ browserName }) => browserName === 'webkit', "Playwright's WebKit has no popup blocker");

const FIREFOX_PREFS = {
    'dom.disable_open_during_load': true,
    'dom.disable_open_click_delay': 1000,
    'dom.popup_maximum': 20,
    'dom.user_activation.transient.timeout': 5000,
    'dom.popup_allowed_events': 'change click dblclick auxclick mouseup pointerup notificationclick reset submit touchend contextmenu',
};

async function openBrowser(browserName: string): Promise<{ context: BrowserContext; page: Page; close: () => Promise<void> }> {
    if (browserName === 'chromium') {
        const profile = mkdtempSync(path.join(tmpdir(), 'review3-links-'));
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

interface Setup { links: string[]; html: string; entry: string; report: string }

function hostPage(setup: Setup) {
    if (window !== window.top || !location.protocol.startsWith('http')) return;
    const report = (what: string) => { fetch(`${setup.report}/${what}`, { mode: 'no-cors', cache: 'no-store' }).catch(() => {}); };
    const open = window.open;
    window.open = function (this: Window, ...args: unknown[]) {
        report(`open?${new URLSearchParams({ url: String(args[0]) })}`);
        return Reflect.apply(open, this, args);
    } as typeof window.open;
    const start = () => {
        if ((window as any).harnessReady !== true) return void setTimeout(start, 20);
        const element = document.querySelector('web-sandbox') as any;
        element.addEventListener('ready', () => report('ready'));
        element.start({ html: setup.html, entry: 'main.js', files: { 'main.js': setup.entry } }, { links: setup.links, methods: { rendered: () => { report('rendered'); return true; } } });
    };
    start();
}

const BOX = 'position:absolute;display:block;width:120px;height:40px;margin:0';
const MARKUP = (a: string) => `<a id="a" href="${a}" style="${BOX};left:10px;top:10px">listed</a><p id="off" style="${BOX};left:150px;top:130px">off</p>`;
const ENTRY = `sandboxView.on('click', 'off', () => { sandboxView.set('a', { focus: true }); bridge.call('rendered'); }); setTimeout(() => bridge.call('rendered'), 0);`;

const reports = () => recorder.paths('blocked').map(entry => decodeURIComponent(entry));
const openReports = () => reports().filter(entry => entry.startsWith('/open?'));

test('one held Enter on the marked link the guest focused: how many window.open calls, and how many tabs', async ({ browserName }) => {
    test.setTimeout(60_000);
    const A = `${recorder.allowed}/link/a`;
    const { page, close } = await openBrowser(browserName);
    try {
        await page.addInitScript(hostPage, { links: [A], html: MARKUP(A), entry: ENTRY, report: recorder.blocked });
        await page.goto(HARNESS);
        await recorder.waitFor('blocked', '/ready', 15000);
        await recorder.waitFor('blocked', '/rendered', 15000);
        await page.mouse.click(8 + 210, 8 + 150); // on #off: the view gets the user's focus, the guest moves it to the link
        await expect.poll(() => reports().filter(report => report === '/rendered').length).toBe(2);
        await page.waitForTimeout(5500); // the click's activation is over
        expect(openReports()).toEqual([]);
        await page.keyboard.down('Enter');
        for (let i = 0; i < 9; i++) {
            await page.waitForTimeout(40);
            await page.keyboard.down('Enter'); // auto-repeat: Playwright marks a second down of a held key as a repeat
        }
        await page.keyboard.up('Enter');
        await page.waitForTimeout(3000);
        const opens = openReports().length;
        const tabs = recorder.paths('allowed').filter(entry => entry.startsWith('/link/a')).length;
        console.log(`[review-3] ${browserName}: one held Enter (1 + 9 repeats): ${opens} window.open call(s), ${tabs} tab(s) reached the listed URL`);
        expect(opens).toBeGreaterThanOrEqual(1);
    } finally {
        await close();
    }
});

// The same held key, with two marked links: on each keydown the view forwards, the guest moves its focus to the other
// link, so each repeat carries a choice of the guest's (here: alternate). What the listed servers see, in order.
const MARKUP_2 = (a: string, b: string) => `<a id="a" href="${a}" style="${BOX};left:10px;top:10px">A</a><a id="b" href="${b}" style="${BOX};left:10px;top:60px">B</a><p id="off" style="${BOX};left:150px;top:130px">off</p>`;
const ENTRY_2 = `
    sandboxView.on('click', 'off', () => { sandboxView.set('a', { focus: true }); bridge.call('rendered'); });
    sandboxView.on('keydown', 'a', () => sandboxView.set('b', { focus: true }));
    sandboxView.on('keydown', 'b', () => sandboxView.set('a', { focus: true }));
    setTimeout(() => bridge.call('rendered'), 0);`;

test('one held Enter, two marked links: the guest chooses the listed URL of every repeat', async ({ browserName }) => {
    test.setTimeout(60_000);
    const A = `${recorder.allowed}/link/a`;
    const B = `${recorder.allowed}/link/b`;
    const { page, close } = await openBrowser(browserName);
    try {
        await page.addInitScript(hostPage, { links: [A, B], html: MARKUP_2(A, B), entry: ENTRY_2, report: recorder.blocked });
        await page.goto(HARNESS);
        await recorder.waitFor('blocked', '/ready', 15000);
        await recorder.waitFor('blocked', '/rendered', 15000);
        await page.mouse.click(8 + 210, 8 + 150);
        await expect.poll(() => reports().filter(report => report === '/rendered').length).toBe(2);
        await page.waitForTimeout(5500);
        expect(openReports()).toEqual([]);
        await page.keyboard.down('Enter');
        for (let i = 0; i < 9; i++) {
            await page.waitForTimeout(80); // a slow repeat rate, so the guest's focus lands between repeats
            await page.keyboard.down('Enter');
        }
        await page.keyboard.up('Enter');
        await page.waitForTimeout(3000);
        const opened = openReports().map(entry => entry.endsWith('/link/a') ? 'A' : entry.endsWith('/link/b') ? 'B' : '?').join('');
        const tabs = recorder.paths('allowed').filter(entry => entry.startsWith('/link/')).map(entry => entry.slice(-1).toUpperCase()).join('');
        console.log(`[review-3] ${browserName}: one held Enter, two links: window.open of ${opened || 'nothing'}; tabs reached ${tabs || 'nothing'}`);
        expect(opened.length).toBeGreaterThanOrEqual(1);
    } finally {
        await close();
    }
});
