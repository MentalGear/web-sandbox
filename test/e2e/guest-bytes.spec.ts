import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Download, Page } from '@playwright/test';
import { test, expect, type SandboxDriver } from './fixture';

/**
 * A guest write's content is a GuestBytes (I9, design 02 "GuestBytes"; src/lib/guest-bytes.ts), in sealed mode on the
 * default build, on every engine:
 *   1. save() of `invoice.pdf.exe` and `report.html` has the browser save files named `invoice.pdf.exe.download` and
 *      `report.html.download` (the library's names, never the guest's path), holding the write's bytes exactly; and of
 *      an inert write (`notes.txt`) the file under its own name (the positive control of the suffix);
 *   2. save() navigates nothing and opens no page: the host page stays at its URL, no `blob:` document of its origin is
 *      opened in any page or frame, no link is left in its document, and the blob's URL is revoked once it is clicked;
 *   3. image() of a PNG write is a Blob an `<img>` decodes, typed image/png; image() of an SVG write, and of HTML written
 *      to a `.png` path, is null.
 * Evidence: Playwright's download event (the browser's suggested name, and the saved file read from disk), the context's
 * pages and the host page's frames and URL, read outside the guest; the guest only writes.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LOGO = readFileSync(path.join(ROOT, 'examples/sealed-app/logo.png'));

const WRITES = {
    'out/invoice.pdf.exe': 'MZ\u0090\u0000 not a real program',
    'out/report.html': '<!doctype html><title>RENDERED</title><script>document.title = "SCRIPT RAN"</script><h1>guest bytes</h1>',
    'out/notes.txt': 'plain notes',
    'out/drawing.svg': '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>parent.stolen = 1</script></svg>',
    'out/fake.png': '<!doctype html><script>alert(1)</script>',
} as const;

/** Mounts sealed mode with writes on; the entry writes WRITES and a copy of the registered PNG to `out/chart.png`. */
async function mountWithWrites(sandbox: SandboxDriver) {
    const body = `
        const writes = ${JSON.stringify(WRITES)};
        for (const [path, text] of Object.entries(writes)) await sandboxFiles.write(path, text);
        await sandboxFiles.write('out/chart.png', await sandboxFiles.read('logo.png'));
        return (await sandboxFiles.list()).filter((p) => p.startsWith('out/')).sort();`;
    const written = await sandbox.inEntry({ mode: 'sealed', guestWrites: true }, body, { 'logo.png': { base64: LOGO.toString('base64') } });
    expect(written).toEqual(['out/chart.png', ...Object.keys(WRITES)].sort());
}

/** The host page's own view of what save() of the write at `path` did, besides the download. */
async function saveFromHost(page: Page, path: string) {
    return page.evaluate((path) => {
        const minted: string[] = [];
        const create = URL.createObjectURL;
        URL.createObjectURL = (blob: Blob) => {
            const url = create.call(URL, blob);
            minted.push(url);
            return url;
        };
        try {
            const write = (document.querySelector('web-sandbox') as any).listGuestWrites().find((w: any) => w.path === path);
            return { returned: write.content.save() ?? null, minted, links: document.querySelectorAll('a[download]').length };
        } finally {
            URL.createObjectURL = create;
        }
    }, path);
}

/** Whether `url` still resolves in the host page: false once it is revoked. */
const resolves = (page: Page, url: string) => page.evaluate(async (url) => {
    try {
        await (await fetch(url)).arrayBuffer();
        return true;
    } catch {
        return false;
    }
}, url);

/** Every page of the context and every frame of each, by URL. */
const everyUrl = (page: Page) => {
    const urls: string[] = [];
    for (const open of page.context().pages()) for (const frame of open.frames()) urls.push(frame.url());
    return urls;
};

const savedBytes = async (download: Download) => readFileSync((await download.path())!);

test.describe('GuestBytes: save() names the file, image() types the image (I9)', () => {
    test('1, 2. save() saves invoice.pdf.exe and report.html under the library\'s names, with the write\'s bytes; an inert write keeps its name; nothing navigates, no blob: document opens, the URL is revoked', async ({ sandbox, page }) => {
        await mountWithWrites(sandbox);
        const hostUrl = page.url();
        const pagesBefore = page.context().pages().length;
        const navigations: string[] = [];
        page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
        const opened: string[] = [];
        page.context().on('page', (p) => opened.push(p.url()));

        const cases: [string, string][] = [
            ['out/invoice.pdf.exe', 'invoice.pdf.exe.download'],
            ['out/report.html', 'report.html.download'],
            ['out/notes.txt', 'notes.txt'],
        ];
        for (const [path, name] of cases) {
            const downloaded = page.waitForEvent('download');
            const host = await saveFromHost(page, path);
            const download = await downloaded;
            expect(download.suggestedFilename(), path).toBe(name);
            expect((await savedBytes(download)).toString('utf8'), path).toBe(WRITES[path as keyof typeof WRITES]);
            expect(host.returned, path).toBe(null);
            expect(host.minted, `${path}: one object URL, of the host page's origin`).toHaveLength(1);
            expect(host.minted[0]!.startsWith(`blob:${new URL(hostUrl).origin}/`)).toBe(true);
            expect(host.links, `${path}: no link left in the document`).toBe(0);
            expect(await resolves(page, host.minted[0]!), `${path}: the URL is revoked`).toBe(false);
        }

        expect(page.url()).toBe(hostUrl);
        expect(navigations).toEqual([]);
        expect(opened).toEqual([]);
        expect(page.context().pages()).toHaveLength(pagesBefore);
        const blobDocuments = everyUrl(page).filter((url) => url.startsWith('blob:'));
        expect(blobDocuments, 'no blob: document is open in any page or frame').toEqual([]);
        expect(await page.title(), 'the host page is still the host page').not.toMatch(/RENDERED|SCRIPT RAN/);
    });

    test('3. image() of a PNG write decodes in an <img>, typed image/png; of an SVG write, and of HTML at a .png path, it is null', async ({ sandbox, page }) => {
        await mountWithWrites(sandbox);
        const r = await page.evaluate(async () => {
            const writes = (document.querySelector('web-sandbox') as any).listGuestWrites();
            const at = (path: string) => writes.find((w: any) => w.path === path).content;
            const image: Blob = at('out/chart.png').image();
            const img = document.createElement('img');
            img.src = URL.createObjectURL(image);
            await img.decode();
            return {
                type: image.type,
                size: [img.naturalWidth, img.naturalHeight],
                svg: at('out/drawing.svg').image(),
                fakePng: at('out/fake.png').image(),
                html: at('out/report.html').image(),
            };
        });
        expect(r).toEqual({ type: 'image/png', size: [24, 24], svg: null, fakePng: null, html: null });
    });
});
