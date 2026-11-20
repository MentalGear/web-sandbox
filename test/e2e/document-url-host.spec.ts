import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BrowserContext, Page } from '@playwright/test';
import { test, expect, ORIGIN } from './fixture';
import { pageDocumentUrl } from './library';
import { DOCUMENT_URL_RULES, OPAQUE_ORIGIN, type DocumentUrlRule } from '@src/lib/document-url';
import { fixedDetail, reasonText } from '@src/lib/reasons';

/**
 * `documentUrl` on host pages that are not on `http(s)`, on every engine (design 05, row 3.10; the owner's decision 3;
 * research 34): off `http(s)`, a `documentUrl` is admitted only on the host page's own origin where that origin, as the
 * page reads it (`self.origin`), is neither opaque nor an extension's. What a browser can show of it:
 *
 *  1. Opaque host pages, each refused with the rule that names an `http(s)` copy of the file, before anything is
 *     defined; with that copy, the same page defines the element and an app is `ready`:
 *     - a browser's `file:` page, with the file beside it, whose origin reads `"null"` (so the file's guard, I14,
 *       cannot tell a sandboxed frame of it from an unsandboxed one there);
 *     - a page that a `sandbox` policy makes opaque;
 *     - a `data:` page.
 *     The URLs refused there are the ones that page can name off http(s): the file beside it (`file:` only), a `data:`
 *     document, and a `blob:` URL the page minted itself, whose parsed origin is the page's own ("null").
 *  2. An http(s) host page: a `file:` URL and a `blob:` URL the page minted itself (whose parsed origin is the page's
 *     own) are refused as another origin.
 *
 * The library is the default build's bundle (`dist/index.js`, which the e2e server's start builds), imported from a
 * `blob:` URL the page mints, since a module of the e2e server's is a cross-origin request from an opaque page. Electron's
 * `file:` page and an app shell's own scheme, the pages the rule admits off http(s), are research 34's Electron probe
 * against the library (docs/research/34_non_http_host/probe-electron-library.mjs).
 */

const ROOT = path.resolve(import.meta.dirname, '../..');
const LIBRARY = () => readFileSync(path.join(ROOT, 'dist/index.js'), 'utf8');
const HTTP_COPY = `${ORIGIN}${pageDocumentUrl('default')}`;

const refusal = (rule: DocumentUrlRule) => `TypeError: [Sandbox] defineWebSandbox(): ${reasonText('documentUrlRefused', fixedDetail(DOCUMENT_URL_RULES[rule]))}.`;

/** The `documentUrl`s a page tries before the one it defines the element with: each a URL, or how the page mints one. */
type Attempt = { readonly name: string; readonly url: string } | { readonly name: string; readonly mint: 'blob' };

interface Outcome {
    readonly origin: string;
    readonly refusals: Record<string, string>;
    readonly definedBeforeCopy: boolean;
    readonly definedWithCopy: boolean;
    readonly outcome: string;
}

// In `page`: imports the library, tries each attempt (every one must throw), then defines the element with `copy` and
// starts one sealed app.
function tryHost(page: Page, attempts: readonly Attempt[], copy: string): Promise<Outcome> {
    return page.evaluate(async ({ library, attempts, copy }) => {
        const { defineWebSandbox } = await import(URL.createObjectURL(new Blob([library], { type: 'text/javascript' })));
        const refusals: Record<string, string> = {};
        for (const attempt of attempts) {
            const url = 'url' in attempt ? attempt.url : URL.createObjectURL(new Blob(['<!doctype html>'], { type: 'text/html' }));
            try {
                defineWebSandbox({ documentUrl: url });
                refusals[attempt.name] = 'defined';
            } catch (error) {
                refusals[attempt.name] = `${(error as Error).name}: ${(error as Error).message}`;
            }
        }
        const definedBeforeCopy = customElements.get('web-sandbox') !== undefined;
        defineWebSandbox({ documentUrl: copy });
        const definedWithCopy = customElements.get('web-sandbox') !== undefined;
        const outcome = await new Promise<string>(resolve => {
            const el = document.createElement('web-sandbox') as HTMLElement & { start(app: object): void };
            el.style.cssText = 'display:block;width:400px;height:300px';
            el.addEventListener('ready', () => resolve('ready'), { once: true });
            el.addEventListener('terminated', (event) => resolve(`terminated: ${(event as CustomEvent).detail.reason}`), { once: true });
            el.start({ html: '<p id="hello">hello</p>' });
            document.body.append(el);
        });
        return { origin: self.origin, refusals, definedBeforeCopy, definedWithCopy, outcome };
    }, { library: LIBRARY(), attempts, copy });
}

// Chromium's local network access: an opaque page that frames or requests the loopback e2e server needs the permission,
// as a page of a public site would for a loopback address (served-view.spec.ts grants it the same way). A deployment's
// http(s) copy is on the site's own server, not on loopback.
async function allowLocalNetwork(context: BrowserContext) {
    if (context.browser()?.browserType().name() === 'chromium') await context.grantPermissions(['local-network-access']);
}

const OWN_BLOB = { name: 'a blob: URL of its own', mint: 'blob' } as const;
const DATA = { name: 'a data: document', url: 'data:text/html,<!doctype html><p>x</p>' } as const;

test.describe('1. an opaque host page: every documentUrl off http(s) is refused with the rule that names an http(s) copy', () => {
    test("a browser's file: page, with the file beside it", async ({ page }, testInfo) => {
        const dir = testInfo.outputPath('file-host');
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><title>file host</title></head><body></body></html>');
        copyFileSync(path.join(ROOT, 'dist/sealed-document.html'), path.join(dir, 'sealed-document.html'));
        await page.goto(pathToFileURL(path.join(dir, 'index.html')).href);
        const beside = pathToFileURL(path.join(dir, 'sealed-document.html')).href;
        const attempts = [{ name: 'the file beside it, relative', url: 'sealed-document.html' }, { name: 'the file beside it, absolute', url: beside }, DATA, OWN_BLOB];
        const result = await tryHost(page, attempts, HTTP_COPY);
        expect(result.origin).toBe(OPAQUE_ORIGIN); // research 34: a browser's file: page reads "null", sandboxed or not
        for (const { name } of attempts) expect(result.refusals[name], name).toBe(refusal('opaqueHost'));
        expect(result.definedBeforeCopy).toBe(false);
        expect(result.outcome).toBe('ready');
    });

    test('a page that a sandbox policy makes opaque', async ({ page, context }) => {
        await allowLocalNetwork(context);
        await page.route(`${ORIGIN}/__document-url/opaque.html`, route => route.fulfill({
            contentType: 'text/html',
            headers: { 'content-security-policy': 'sandbox allow-scripts' },
            body: '<!doctype html><html><head><meta charset="utf-8"><title>opaque host</title></head><body></body></html>',
        }));
        await page.goto(`${ORIGIN}/__document-url/opaque.html`);
        const result = await tryHost(page, [DATA, OWN_BLOB], HTTP_COPY);
        expect(result.origin).toBe(OPAQUE_ORIGIN);
        for (const name of [DATA.name, OWN_BLOB.name]) expect(result.refusals[name], name).toBe(refusal('opaqueHost'));
        expect(result.definedBeforeCopy).toBe(false);
        expect(result.outcome).toBe('ready');
    });

    test('a data: page', async ({ page, context }) => {
        await allowLocalNetwork(context);
        await page.goto('data:text/html,<!doctype html><html><head><meta charset="utf-8"><title>data host</title></head><body></body></html>');
        const result = await tryHost(page, [DATA, OWN_BLOB], HTTP_COPY);
        expect(result.origin).toBe(OPAQUE_ORIGIN);
        for (const name of [DATA.name, OWN_BLOB.name]) expect(result.refusals[name], name).toBe(refusal('opaqueHost'));
        expect(result.definedBeforeCopy).toBe(false);
        // the http copy is admitted; whether the app is ready is not this test's: Chromium's top-level data: page is not
        // a secure context, and its local network access refuses such a page's request for a loopback address whatever
        // the permission (ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS), so the e2e server's copy is never framed there.
        // The two pages above are ready with it on every engine.
        expect(result.definedWithCopy).toBe(true);
    });
});

test.describe('2. an http(s) host page: a URL off http(s) is another origin, whatever the URL parser reads of it', () => {
    test("a file: URL, and a blob: URL of the page's own, are refused; the file on http is defined", async ({ page }) => {
        await page.route(`${ORIGIN}/__document-url/http.html`, route => route.fulfill({
            contentType: 'text/html',
            body: '<!doctype html><html><head><meta charset="utf-8"><title>http host</title></head><body></body></html>',
        }));
        await page.goto(`${ORIGIN}/__document-url/http.html`);
        const attempts = [{ name: 'a file: URL', url: 'file:///srv/app/sealed-document.html' }, DATA, OWN_BLOB];
        const result = await tryHost(page, attempts, pageDocumentUrl('default'));
        expect(result.origin).toBe(ORIGIN);
        for (const { name } of attempts) expect(result.refusals[name], name).toBe(refusal('scheme'));
        expect(result.definedBeforeCopy).toBe(false);
        expect(result.outcome).toBe('ready');
    });
});
