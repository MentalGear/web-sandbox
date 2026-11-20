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
 *                          `h` adds a response header, `cors` allows any origin to read it, `cache` makes it cacheable;
 *                          for the start-up order's spec (test/e2e/startup-order.spec.ts): `fAnnounces` (the file's own
 *                          document announces itself to the host page), `secondFrame` (a second frame inside the file,
 *                          after the view, announces itself), `fallbackFrame` (an app's page with a frame that says
 *                          nothing); `spy=1` gives the view a listener, ahead of its bootstrap's, that tells the host page
 *                          what it was posted (`__spy`), and every window these variants add reports the same; `hold=key`
 *                          answers the frame's navigation only once `release?key=` was asked. A file changed this way states the library's
 *                          version still, as a tool that rewrote the file would leave it;
 *                          for the start-up gates' spec (test/e2e/startup-gates.spec.ts), the mutants of research 31 (Q2):
 *                          `meta=none` takes the file's `<meta>` policy out, `set=directive:sources` gives a directive of it
 *                          other sources and `add=directive:source` one more, and `viewSameOrigin=1` gives the view's
 *                          `sandbox` attribute `allow-same-origin` in a copy without its guard;
 *                          for the policy check's spec (test/e2e/policy-check.spec.ts): `noCheck`, a view whose policy
 *                          check provokes nothing
 *   POST /S/report         a CSP report endpoint (a header on the file names it in `report-uri`); GET /S/reports lists
 *                          what it received, each body parsed
 *   GET /S/hits            what reached the file's path: each request's variant, Sec-Fetch-Dest and the headers that
 *                          carry the page's or the user's state (Cookie, Authorization, Referer)
 *   GET /S/release?key=…   answers the requests held with `hold=key`
 */
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSealedDocument } from '../../src/lib/sealed-document';
import { statedDigest } from '../../src/lib/document-digest';
import { gatesOf } from '../../src/lib/startup-gates';
import { scriptHashSource } from '../../src/lib/csp/script-hash';
import { POLICY_ATTRIBUTE } from '../../src/lib/policy-check';

export const SERVED_FILE_PATH = '/__served-file';

/** The ways the file is served wrong, and right. */
export const FILE_VARIANTS = ['library', 'missing', 'plain', 'fallback', 'devClient', 'minified', 'noGuard', 'noSandbox', 'otherVersion', 'checkGetsFile', 'frameGetsFile', 'fAnnounces', 'secondFrame', 'fallbackFrame', 'noCheck'] as const;
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
// The CSP reports each session's endpoint received (`report`), as their bodies parsed.
const reportsOf = new Map<string, unknown[]>();
const reportList = (session: string) => {
    let list = reportsOf.get(session);
    if (!list) reportsOf.set(session, list = []);
    return list;
};
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

// The version a generated file states (VERSION_ATTRIBUTE): the file's own digest.
const versionOf = (file: string): string => statedDigest(file)!;

/** The file for another bootstrap, generated as the library generates it, stating `version` in place of its own. */
function withBootstrap(bootstrap: string, version: string): string {
    const generated = renderSealedDocument(bootstrap);
    return generated.replace(versionOf(generated), version);
}

/**
 * The spy (`spy=1`): a script that reports to the host page whatever its window is posted, as `__spy` with where it runs,
 * the message's type and how many ports came with it. In the view it is a capture listener ahead of the bootstrap's own,
 * which stops INIT_VIEW once it took it.
 */
const spy = (where: string, target: string) => `addEventListener('message', function (e) { ${target}.postMessage({ type: '__spy', where: '${where}', got: e.data && e.data.type, ports: e.ports.length }, '*'); }, true);`;

/** An announcement as the view makes it, with the version the library states and every gate of the view's held. */
function announcement(version: string): string {
    const verdicts: Record<string, boolean> = {};
    for (const name of gatesOf('view', 'sealed')) verdicts[name] = true;
    return JSON.stringify({ type: 'VIEW_ANNOUNCE', version, verdicts });
}

/**
 * F with one more script admitted by its policy: `script` at the end of F's head, or as a frame's document after C. The
 * view's document states the changed policy as F's `<meta>` holds it (POLICY_ATTRIBUTE), so the view's policy check sees
 * one policy, the file's own, as in the library's file: what these variants test is the order, not the check.
 */
function withScriptInFile(file: string, script: string, where: 'head' | 'frame'): string {
    const source = `script-src ${scriptHashSource(script)} '`;
    const stated = new RegExp(`(${POLICY_ATTRIBUTE}=&quot;[^&]*?)script-src '`);
    const admitted = file.replace("script-src '", source).replace(stated, (_all, before: string) => `${before}${source}`);
    if (where === 'head') return admitted.replace('</head>', `<script>${script}</script></head>`);
    const srcdoc = `<script>${script}</script>`.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    return admitted.replace('</iframe>', `</iframe><iframe srcdoc="${srcdoc}"></iframe>`);
}

/** An app's own page with a frame of its own, at index 0, that says nothing and reports whatever it is posted. */
const fallbackWithFrame = () => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>The app</title></head><body><iframe srcdoc="${`<script>${spy('fallbackFrame', 'parent.parent')}</script>`.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')}"></iframe></body></html>\n`;

/**
 * The file with its `<meta>` policy changed as `query` asks (research 31, Q2's mutants): taken out, a directive given
 * other sources, or one more source. The view's version and every other byte stay.
 */
function mutated(file: string, query: URLSearchParams): string {
    let text = file;
    if (query.get('meta') === 'none') text = text.replace(/<meta http-equiv="Content-Security-Policy" content="[^"]*">/, '');
    for (const pair of query.getAll('set')) {
        const colon = pair.indexOf(':');
        text = text.replace(new RegExp(`(content="[^"]*?)(${pair.slice(0, colon)} [^;"]*)`), (_all, before: string) => `${before}${pair.slice(0, colon)} ${pair.slice(colon + 1)}`);
    }
    for (const pair of query.getAll('add')) {
        const colon = pair.indexOf(':');
        text = text.replace(new RegExp(`(content="[^"]*?${pair.slice(0, colon)} [^;"]*)`), (all: string) => `${all} ${pair.slice(colon + 1)}`);
    }
    if (query.get('viewSameOrigin') === '1') {
        text = text.replace(/<script>[^<]*<\/script>/, '').replace(/<iframe sandbox="([^"]*)"/, (_all, flags: string) => `<iframe sandbox="${flags} allow-same-origin"`);
    }
    return text;
}

/** The view's bootstrap with the policy check's canaries taken out of its options (in-sandbox-view.ts, ViewOptions.policy). */
function withoutCanaries(bootstrap: string): string {
    const open = `"policy":{"attribute":"${POLICY_ATTRIBUTE}","refused":`;
    const start = bootstrap.indexOf(open);
    const end = bootstrap.indexOf(',"findings":', start);
    if (start === -1 || end === -1) throw new Error('withoutCanaries: the bootstrap has no policy check where it is expected');
    return `${bootstrap.slice(0, start)}${open}[],"admitted":[]${bootstrap.slice(end)}`;
}

/** The file's text as `variant` serves it to a request whose Sec-Fetch-Dest is `dest`; `spied`, with the spy in its view. */
function fileText(variant: FileVariant, dest: string | null, spied = false): string {
    const built = readFileSync(join(ROOT, 'dist', 'sealed-document.html'), 'utf8');
    const file = spied ? withBootstrap(spy('view', 'parent.parent') + bootstrapOf(built), versionOf(built)) : built;
    switch (variant) {
        case 'fAnnounces': return withScriptInFile(file, `parent.postMessage(${announcement(versionOf(built))}, '*');${spy('file', 'parent')}`, 'head');
        case 'secondFrame': return withScriptInFile(file, `parent.parent.postMessage(${announcement(versionOf(built))}, '*');${spy('secondFrame', 'parent.parent')}`, 'frame');
        case 'fallbackFrame': return fallbackWithFrame();
        case 'devClient': return file.replace('<head>', '<head><script type="module" src="/@vite/client"></script>');
        // what an HTML minifier does to it: the doctype lower-cased, the last newline gone
        case 'minified': return file.replace('<!DOCTYPE html>', '<!doctype html>').trimEnd();
        case 'noGuard': return file.replace(/<script>[^<]*<\/script>/, '');
        case 'noSandbox': return file.replace(/<iframe sandbox="[^"]*"/, '<iframe');
        // another version's file: the generator's output for another bootstrap, its policy admitting that one
        case 'otherVersion': return renderSealedDocument(bootstrapOf(file).replace("'use strict';", "'use strict'; "));
        // the policy check's spec (test/e2e/policy-check.spec.ts): a view whose check provokes nothing (its lists of
        // canaries empty), stating the library's version: the mutant of a check that is gone, and the baseline of its cost
        case 'noCheck': return withBootstrap(withoutCanaries(bootstrapOf(file)), versionOf(built));
        // (the spy stays in the other version's view: it states its own version)
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

// The requests held until their key is released (`hold`), per key.
const held = new Map<string, (() => void)[]>();
const release = (key: string) => {
    for (const answer of held.get(key) ?? []) answer();
    held.delete(key);
};

async function serveFile(req: IncomingMessage, res: ServerResponse, session: string, query: URLSearchParams) {
    const variant = (query.get('variant') ?? 'library') as FileVariant;
    // only the frame's navigation is held: the check's own request (Sec-Fetch-Dest `empty`) is answered at once
    const hold = header(req, 'sec-fetch-dest') === 'empty' ? null : query.get('hold');
    if (hold !== null) await new Promise<void>(resolve => held.set(hold, [...(held.get(hold) ?? []), resolve]));
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
    res.end(mutated(fileText(variant, dest, query.get('spy') === '1'), query));
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
            void serveFile(req, res, session, url.searchParams);
            return;
        }
        if (route === 'release') {
            release(url.searchParams.get('key') ?? '');
            res.setHeader('cache-control', 'no-store');
            res.end('released');
            return;
        }
        // the endpoint a header on the file names in `report-uri` (the policy check's spec), and what it received
        if (route === 'report' && req.method === 'POST') {
            const chunks: Buffer[] = [];
            req.on('data', (chunk: Buffer) => chunks.push(chunk));
            req.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf8');
                let parsed: unknown = body;
                try { parsed = JSON.parse(body); } catch { /* kept as text */ }
                reportList(session).push(parsed);
                res.statusCode = 204;
                res.end();
            });
            return;
        }
        if (route === 'reports') {
            res.setHeader('content-type', 'application/json');
            res.setHeader('cache-control', 'no-store');
            res.end(JSON.stringify(reportList(session)));
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
