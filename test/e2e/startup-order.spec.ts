import { randomUUID } from 'node:crypto';
import type { BrowserContext, Page } from '@playwright/test';
import { test, expect, ORIGIN, OFFSITE_ORIGIN } from './fixture';
import { E2E_PORT } from './server';
import { servedFileBytes } from './served-file';
import { SERVED_FILE_PATH, type FileVariant } from './served-file-server';
import { statedDigest } from '@src/lib/document-digest';
import { gatesOf } from '@src/lib/startup-gates';
import { reasonText } from '@src/lib/reasons';

/**
 * The start-up order (design 03, "The start-up order" and "Who receives the first port"; design 05, row 3.4), on every
 * engine, in the shipped static file: the view speaks first, with the version its document states and its gates'
 * verdicts, and the host page posts the ports and the app, in the handler that tested the source, only to the window that
 * announced itself from the first frame of the element's frame, and only when they are its own.
 *
 * The file is served from another origin that does not allow the host page to read it, so the check of the file cannot
 * run (design 03, "The check of the file"), and what is tested is the announcement alone. Each window's spy
 * (served-file-server.ts, `spy`) tells the host page what that window was posted, and the host page's own listener hears
 * each window's announcement, so a test knows the forged one arrived (served-file-page.ts). That the element took the
 * view's and no other is what the spies show: one INIT_VIEW, to the view, and the build `ready`.
 *
 *  1. A file of another version announces itself and receives no port; the library's file, the same way, does.
 *  2. Each window that is not the view announces itself, with the library's version and every gate held, and receives
 *     nothing, and the view is still accepted afterwards: a frame of the host page, the file's own document, a second
 *     frame inside the file, a page that frames the host page.
 *  3. A page that is not the file and says nothing receives no port, and a document that never announces itself ends
 *     with "the document did not answer": a page with no frame at once, one whose frame says nothing at the deadline.
 */

const VERSION = statedDigest(servedFileBytes().toString('utf8'))!;
const CLEAN = (() => {
    const verdicts: Record<string, boolean> = {};
    for (const name of gatesOf('view', 'sealed')) verdicts[name] = true;
    return { type: 'VIEW_ANNOUNCE', version: VERSION, verdicts };
})();

interface Outcome { outcome: 'ready' | 'terminated'; reason: string | null }
interface Heard { type: string; from: string; where?: string; got?: string; ports?: number }

/** A session of the file's server, with the file on another origin that allows no read. */
function session() {
    const id = randomUUID();
    return {
        file: (variant: FileVariant, extra: Record<string, string> = {}) => `${OFFSITE_ORIGIN}${SERVED_FILE_PATH}/${id}/file/sealed-document.html?${new URLSearchParams({ variant, spy: '1', ...extra })}`,
        page: (doc: string) => `${ORIGIN}${SERVED_FILE_PATH}/${id}/page?${new URLSearchParams({ doc })}`,
        release: (key: string) => fetch(`${ORIGIN}${SERVED_FILE_PATH}/${id}/release?key=${key}`),
    };
}

async function open(page: Page, url: string) {
    await page.goto(url);
    await page.waitForFunction(() => (window as any).harnessReady === true);
}

/** Starts one sealed app, and waits until the element's frame is in its shadow root (its file not necessarily loaded). */
async function start(page: Page) {
    await page.evaluate(() => { (window as any).pending = (window as any).startSandbox(); });
    await page.waitForFunction(() => !!document.querySelector('web-sandbox')?.shadowRoot?.querySelector('iframe'));
}
const outcomeOf = (page: Page): Promise<Outcome> => page.evaluate(async () => { const { outcome, reason } = await (window as any).pending; return { outcome, reason }; });
const heard = (page: Page): Promise<Heard[]> => page.evaluate(() => (window as any).heard);

/** What `where` was posted, as its spy reported it: the types, with the ports each came with. */
const postedTo = (all: Heard[], where: string) => all.filter(entry => entry.type === '__spy' && entry.where === where).map(entry => `${entry.got}:${entry.ports}`);
/** The announcements of windows other than the view that reached the host page: the element ignored them. */
const unheardBy = (all: Heard[]) => all.filter(entry => entry.type === 'VIEW_ANNOUNCE' && entry.from !== 'view').map(entry => entry.from);

/** Chromium refuses a routed page's frame of the loopback without this permission (served-view.spec.ts, allowLocalNetwork). */
async function allowLocalNetwork(context: BrowserContext) {
    if (context.browser()?.browserType().name() === 'chromium') await context.grantPermissions(['local-network-access']);
}

test.describe('1. the version: a file of another version receives no port', () => {
    test("the library's file, which states this library's version, is given its port and the app; another version's file announces itself and is given nothing", async ({ page }) => {
        const server = session();
        await open(page, server.page(server.file('library')));
        await start(page);
        expect(await outcomeOf(page)).toEqual({ outcome: 'ready', reason: null });
        expect(postedTo(await heard(page), 'view')).toEqual(['INIT_VIEW:2']);

        const other = session();
        await open(page, other.page(other.file('otherVersion')));
        await start(page);
        expect(await outcomeOf(page)).toEqual({ outcome: 'terminated', reason: reasonText('documentVersion') });
        await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 100))); // a port posted would have been reported by now
        expect(postedTo(await heard(page), 'view')).toEqual([]);
    });
});

test.describe('2. each window that is not the view announces itself and receives nothing; the view is still accepted', () => {
    test('a frame of the host page, before the file has loaded', async ({ page }) => {
        const server = session();
        const key = randomUUID();
        await open(page, server.page(server.file('library', { hold: key })));
        await start(page);
        // the file is held by its server: the element's frame has no document yet, and the sibling speaks first
        await page.evaluate((announcement) => (window as any).siblingAnnounce(announcement), CLEAN);
        await page.waitForFunction(() => (window as any).heard.some((entry: Heard) => entry.type === 'VIEW_ANNOUNCE' && entry.from === 'sibling'));
        await server.release(key);
        expect(await outcomeOf(page)).toEqual({ outcome: 'ready', reason: null });
        const all = await heard(page);
        expect(unheardBy(all)).toEqual(['sibling']);
        expect([postedTo(all, 'sibling'), postedTo(all, 'view')]).toEqual([[], ['INIT_VIEW:2']]);
    });

    test("the file's own document, from its head, before the view exists", async ({ page }) => {
        const server = session();
        await open(page, server.page(server.file('fAnnounces')));
        await start(page);
        expect(await outcomeOf(page)).toEqual({ outcome: 'ready', reason: null });
        const all = await heard(page);
        expect(unheardBy(all)).toEqual(['file']);
        expect([postedTo(all, 'file'), postedTo(all, 'view')]).toEqual([[], ['INIT_VIEW:2']]);
    });

    test('a second frame inside the file, after the view', async ({ page }) => {
        const server = session();
        await open(page, server.page(server.file('secondFrame')));
        await start(page);
        expect(await outcomeOf(page)).toEqual({ outcome: 'ready', reason: null });
        await page.waitForFunction(() => (window as any).heard.some((entry: Heard) => entry.type === 'VIEW_ANNOUNCE' && entry.from === 'other'));
        const all = await heard(page);
        expect(unheardBy(all)).toEqual(['other']);
        expect([postedTo(all, 'secondFrame'), postedTo(all, 'view')]).toEqual([[], ['INIT_VIEW:2']]);
    });

    test('a page that frames the host page, before the file has loaded', async ({ page, context }) => {
        await allowLocalNetwork(context);
        const server = session();
        const key = randomUUID();
        const framing = `http://localhost:${E2E_PORT + 1}/__framing`;
        await context.route(`${framing}**`, route => route.fulfill({
            contentType: 'text/html',
            body: `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><script>window.got = []; addEventListener('message', (e) => window.got.push(String(e.data && e.data.type) + ':' + e.ports.length));</script><iframe src="${server.page(server.file('library', { hold: key }))}" style="width:500px;height:400px"></iframe></body></html>`,
        }));
        await page.goto(framing);
        const host = () => page.frames().find(frame => frame.url().includes(SERVED_FILE_PATH))!;
        await expect.poll(() => host()?.evaluate(() => (window as any).harnessReady === true).catch(() => false)).toBe(true);
        await host().evaluate(() => { (window as any).pending = (window as any).startSandbox(); });
        await host().waitForFunction(() => !!document.querySelector('web-sandbox')?.shadowRoot?.querySelector('iframe'));
        // the framing page posts an announcement into the host page, which it frames: the source is the framing page
        await page.evaluate((announcement) => { (document.querySelector('iframe') as HTMLIFrameElement).contentWindow!.postMessage(announcement, '*'); }, CLEAN);
        await host().waitForFunction(() => (window as any).heard.some((entry: Heard) => entry.type === 'VIEW_ANNOUNCE' && entry.from === 'framing page'));
        await server.release(key);
        expect(await host().evaluate(async () => (await (window as any).pending).outcome)).toBe('ready');
        const all: Heard[] = await host().evaluate(() => (window as any).heard);
        expect(unheardBy(all)).toEqual(['framing page']);
        expect(postedTo(all, 'view')).toEqual(['INIT_VIEW:2']);
        expect(await page.evaluate(() => (window as any).got)).toEqual([]);
    });
});

test.describe('3. a page that is not the file and says nothing receives no port; a document that never announces itself ends with its reason', () => {
    test('an app\'s page with no frame: "the document did not answer", at its load', async ({ page }) => {
        const server = session();
        await open(page, server.page(server.file('fallback')));
        await start(page);
        expect(await outcomeOf(page)).toEqual({ outcome: 'terminated', reason: reasonText('documentSilent') });
    });

    test('an app\'s page whose own frame, at index 0, says nothing: no port reaches that frame, and the deadline ends the build with "the document did not answer"', async ({ page }) => {
        const server = session();
        await open(page, server.page(server.file('fallbackFrame')));
        await start(page);
        expect(await outcomeOf(page)).toEqual({ outcome: 'terminated', reason: reasonText('documentSilent') });
        expect(postedTo(await heard(page), 'fallbackFrame')).toEqual([]);
    });
});
