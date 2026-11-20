/**
 * The server half of the check-of-the-file spec (test/e2e/served-file-check.spec.ts; design 03, "The check of the
 * file"), mounted by vite.config.ts at /__served-file in the e2e server. It serves sealed mode's file the ways a
 * deployment gets it wrong, and records every request for it, per test session:
 *
 *   GET /S/page?doc=…&csp=…&sw=1&wrap=before|after
 *                          a host page (its one script, served-file-page.ts) that registers documentUrl `doc`; `csp` is its
 *                          Content-Security-Policy, `sw` registers the Service Worker below first, `wrap` installs a
 *                          `fetch` wrapper that adds an Authorization header, before or after the library is loaded
 *   GET /S/sw.js           a Service Worker for /S/: it answers a request for the file whose query has `sw=answer` with
 *                          a page of its own, and lets every other request go to the network
 *   GET /S/file/sealed-document.html?variant=…&h=name:value&cors=1&cache=1
 *                          the file the default build wrote (dist/), read at each request, as `variant` makes it:
 *                          `library` (unchanged), `missing` (404), `plain` (text/plain), `fallback` (an app's own page),
 *                          `devClient`, `minified`, `noGuard`, `noSandbox`, `otherVersion` (a file generated, as the
 *                          library generates it, from another bootstrap), `checkGetsFile` and `frameGetsFile` (one
 *                          answer to the check's request, Sec-Fetch-Dest `empty`, and the other page to the frame's);
 *                          `h` adds a response header, `cors` allows any origin to read it, `cache` makes it cacheable
 *   GET /S/hits            what reached the file's path: each request's variant, Sec-Fetch-Dest and the headers that
 *                          carry the page's or the user's state (Cookie, Authorization, Referer)
 */
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSealedDocument } from '../../src/lib/sealed-document';

export const SERVED_FILE_PATH = '/__served-file';

/** The ways the file is served wrong, and right. */
export const FILE_VARIANTS = ['library', 'missing', 'plain', 'fallback', 'devClient', 'minified', 'noGuard', 'noSandbox', 'otherVersion', 'checkGetsFile', 'frameGetsFile'] as const;
export type FileVariant = (typeof FILE_VARIANTS)[number];

export interface FileHit {
    readonly variant: string;
    readonly dest: string | null;
    readonly mode: string | null;
    readonly cookie: string | null;
    readonly authorization: string | null;
    readonly referer: string | null;
    readonly accept: string | null;
}

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const sessions = new Map<string, FileHit[]>();
const hitsOf = (session: string) => {
    let list = sessions.get(session);
    if (!list) sessions.set(session, list = []);
    return list;
};

const FALLBACK_PAGE = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>The app</title></head><body><div id="app">the app\'s own page</div></body></html>\n';

// The view's bootstrap as the file holds it: the text of C's one script, in the srcdoc attribute the generator escaped.
function bootstrapOf(file: string): string {
    const srcdoc = /srcdoc="([^"]*)"/.exec(file)![1]!;
    const view = srcdoc.replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
    return /<script>([\s\S]*)<\/script>/.exec(view)![1]!;
}

/** The file's text as `variant` serves it to a request whose Sec-Fetch-Dest is `dest`. */
function fileText(variant: FileVariant, dest: string | null): string {
    const file = readFileSync(join(ROOT, 'dist', 'sealed-document.html'), 'utf8');
    switch (variant) {
        case 'devClient': return file.replace('<head>', '<head><script type="module" src="/@vite/client"></script>');
        // what an HTML minifier does to it: the doctype lower-cased, the last newline gone
        case 'minified': return file.replace('<!DOCTYPE html>', '<!doctype html>').trimEnd();
        case 'noGuard': return file.replace(/<script>[^<]*<\/script>/, '');
        case 'noSandbox': return file.replace(/<iframe sandbox="[^"]*"/, '<iframe');
        // another version's file: the generator's output for another bootstrap, its policy admitting that one
        case 'otherVersion': return renderSealedDocument(bootstrapOf(file).replace("'use strict';", "'use strict'; "));
        case 'fallback': return FALLBACK_PAGE;
        case 'checkGetsFile': return dest === 'empty' ? file : FALLBACK_PAGE;
        case 'frameGetsFile': return dest === 'empty' ? FALLBACK_PAGE : file;
        default: return file;
    }
}

const header = (req: IncomingMessage, name: string): string | null => {
    const value = req.headers[name];
    return value === undefined ? null : String(value);
};

function serveFile(req: IncomingMessage, res: ServerResponse, session: string, query: URLSearchParams) {
    const variant = (query.get('variant') ?? 'library') as FileVariant;
    const dest = header(req, 'sec-fetch-dest');
    hitsOf(session).push({ variant, dest, mode: header(req, 'sec-fetch-mode'), cookie: header(req, 'cookie'), authorization: header(req, 'authorization'), referer: header(req, 'referer'), accept: header(req, 'accept') });
    res.setHeader('cache-control', query.get('cache') ? 'max-age=3600' : 'no-store');
    // CORS only where the test asks for it: Vite's own CORS middleware, which runs first, admits loopback origins
    if (query.get('cors')) res.setHeader('access-control-allow-origin', '*');
    else res.removeHeader('access-control-allow-origin');
    for (const pair of query.getAll('h')) {
        const colon = pair.indexOf(':');
        res.setHeader(pair.slice(0, colon), pair.slice(colon + 1));
    }
    if (variant === 'missing') {
        res.statusCode = 404;
        res.setHeader('content-type', 'text/html');
        res.end('<!DOCTYPE html><p>not found</p>');
        return;
    }
    res.setHeader('content-type', variant === 'plain' ? 'text/plain' : 'text/html');
    res.end(fileText(variant, dest));
}

// The Service Worker of /S/: it answers the file's requests that ask for it with a page of its own.
const SERVICE_WORKER = `
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (!url.pathname.endsWith('/sealed-document.html') || url.searchParams.get('sw') !== 'answer') return;
    event.respondWith(new Response('<!DOCTYPE html><p>the Service Worker answered</p>', { headers: { 'content-type': 'text/html' } }));
});
`;

const page = (session: string) => '<!DOCTYPE html><html><head><meta charset="utf-8"><title>served file check</title>'
    + `<script type="module" src="/test/e2e/served-file-page.ts?session=${encodeURIComponent(session)}"></script></head><body></body></html>`;

/** The middleware for `server.middlewares.use(SERVED_FILE_PATH, …)`: `req.url` is relative to the mount. */
export function servedFileMiddleware() {
    return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const [, session = '', ...rest] = url.pathname.split('/');
        const route = rest.join('/');
        if (route === 'page') {
            res.setHeader('content-type', 'text/html; charset=utf-8');
            res.setHeader('cache-control', 'no-store');
            const csp = url.searchParams.get('csp');
            if (csp) res.setHeader('content-security-policy', csp);
            res.end(page(session));
            return;
        }
        if (route === 'sw.js') {
            res.setHeader('content-type', 'text/javascript; charset=utf-8');
            res.setHeader('cache-control', 'no-store');
            res.end(SERVICE_WORKER);
            return;
        }
        if (route === 'file/sealed-document.html') {
            serveFile(req, res, session, url.searchParams);
            return;
        }
        if (route === 'hits') {
            const list = hitsOf(session);
            res.setHeader('content-type', 'application/json');
            res.setHeader('cache-control', 'no-store');
            res.end(JSON.stringify(list));
            return;
        }
        next();
    };
}
