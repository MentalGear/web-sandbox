/**
 * The server half of the realistic host (test/e2e/realistic-host.ts), mounted by vite.config.ts at /__realistic-host in
 * the e2e server. It plays the application's own backend, and records what reaches it, per test session:
 *
 *   GET  /page?session=S&csp=…&h-<header>=…&cookies=0|1&sw=0|1&tt-default=1
 *                          the host page: the headers a production app sends (the Content-Security-Policy the spec
 *                          names, a Permissions-Policy, a Referrer-Policy, nosniff, and the PAGE_HEADERS a spec sets) and, unless cookies=0, the host site's cookies with SameSite None, Lax and Strict.
 *                          Its one script is external (realistic-host-page.ts), so a policy without 'unsafe-inline' runs it.
 *   GET  /sw.js            the host app's Service Worker: cache-first for its API, reporting what it handled
 *   *    /api/S/NAME       the host app's own API: answers { name, n } (n counts the session's hits on that name) and records the
 *                          request with every header the browser sent, so a spec reads the Cookie and Authorization headers and the Referer that
 *                          reached it. CORS for any origin, as a public API's would be
 *   POST /report/S         the page's CSP report-uri, recorded
 *   POST /sw-seen/S        the Service Worker's own log of the requests it handled
 *   GET  /hits/S           everything recorded for the session (?clear=1 empties it)
 *
 * A session is a test's own: tests running at once on one server never see each other's requests.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

export const REALISTIC_HOST_PATH = '/__realistic-host';

/** The host app's cookies and what each says about its SameSite attribute (the page sets them at load). */
export const HOST_COOKIES = [
    { name: 'hs_none', value: 'host-none', attributes: 'SameSite=None; Secure' },
    { name: 'hs_lax', value: 'host-lax', attributes: 'SameSite=Lax' },
    { name: 'hs_strict', value: 'host-strict', attributes: 'SameSite=Strict' },
] as const;

export interface ApiHit {
    name: string;
    method: string;
    path: string;
    headers: Record<string, string | string[] | undefined>;
}

export interface SessionRecord {
    api: ApiHit[];
    serviceWorker: { path: string; from: string }[];
    reports: unknown[];
}

const sessions = new Map<string, SessionRecord & { counters: Map<string, number> }>();
const sessionOf = (id: string) => {
    let record = sessions.get(id);
    if (!record) sessions.set(id, record = { api: [], serviceWorker: [], reports: [], counters: new Map() });
    return record;
};

// The host app's Service Worker: an ordinary cache-first worker for its own API (Workbox's CacheFirst runtime caching),
// that logs each request it handled to the server, from the worker itself (a worker's own fetches are not routed through it).
const SERVICE_WORKER = `
const API = '${REALISTIC_HOST_PATH}/api/';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (!url.pathname.startsWith(API)) return;
    const session = url.pathname.slice(API.length).split('/')[0];
    event.respondWith((async () => {
        const cache = await caches.open('host-api');
        const cached = await cache.match(event.request.url);
        event.waitUntil(fetch('${REALISTIC_HOST_PATH}/sw-seen/' + session + '?path=' + encodeURIComponent(url.pathname + url.search) + '&from=' + (cached ? 'cache' : 'network'), { method: 'POST' }).catch(() => {}));
        if (cached) return cached;
        const response = await fetch(event.request);
        if (response.ok) await cache.put(event.request.url, response.clone());
        return response;
    })());
});
`;

/** The headers of the page that a spec can set or replace (`h-<name>` in the query). */
export const PAGE_HEADERS = ['cross-origin-opener-policy', 'cross-origin-embedder-policy', 'referrer-policy', 'permissions-policy'] as const;
export type PageHeader = (typeof PAGE_HEADERS)[number];

const PAGE = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Realistic host</title>'
    + '<script type="module" src="/test/e2e/realistic-host-page.ts"></script></head>'
    + '<body><main id="app">The application</main></body></html>';

function readBody(req: IncomingMessage): Promise<string> {
    return new Promise(resolve => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
}

const json = (res: ServerResponse, body: unknown, status = 200) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(body));
};

/** The middleware for `server.middlewares.use(REALISTIC_HOST_PATH, …)`: `req.url` is relative to the mount. */
export function realisticHostMiddleware() {
    return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const [, route = '', session = '', ...rest] = url.pathname.split('/');

        if (route === 'page') {
            const query = url.searchParams;
            res.setHeader('content-type', 'text/html; charset=utf-8');
            res.setHeader('cache-control', 'no-store');
            res.setHeader('x-content-type-options', 'nosniff');
            res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
            res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
            const csp = query.get('csp');
            if (csp) res.setHeader('content-security-policy', csp);
            // the other headers a spec sets, as `h-<name>=<value>` (the page's own defaults above are replaced)
            for (const header of PAGE_HEADERS) {
                const value = query.get(`h-${header}`);
                if (value !== null) res.setHeader(header, value);
            }
            if (query.get('cookies') !== '0') res.setHeader('set-cookie', HOST_COOKIES.map(cookie => `${cookie.name}=${cookie.value}; Path=/; ${cookie.attributes}`));
            res.end(PAGE);
            return;
        }
        if (route === 'sw.js') {
            res.setHeader('content-type', 'text/javascript; charset=utf-8');
            res.setHeader('cache-control', 'no-store');
            res.end(SERVICE_WORKER);
            return;
        }
        if (route === 'api') {
            const record = sessionOf(session);
            const name = rest.join('/');
            const headers = { ...req.headers };
            record.api.push({ name, method: req.method ?? '', path: url.pathname + url.search, headers });
            res.setHeader('access-control-allow-origin', '*');
            res.setHeader('cross-origin-resource-policy', 'cross-origin');
            if (req.method === 'OPTIONS') {
                res.statusCode = 204;
                res.setHeader('access-control-allow-methods', '*');
                res.setHeader('access-control-allow-headers', '*');
                res.setHeader('access-control-max-age', '0');
                res.end();
                return;
            }
            const n = (record.counters.get(name) ?? 0) + 1;
            record.counters.set(name, n);
            json(res, { name, n });
            return;
        }
        if (route === 'report') {
            const body = await readBody(req);
            let parsed: unknown = body;
            try { parsed = JSON.parse(body); } catch { /* recorded as text */ }
            sessionOf(session).reports.push(parsed);
            res.statusCode = 204;
            res.end();
            return;
        }
        if (route === 'sw-seen') {
            sessionOf(session).serviceWorker.push({ path: url.searchParams.get('path') ?? '', from: url.searchParams.get('from') ?? '' });
            res.statusCode = 204;
            res.end();
            return;
        }
        if (route === 'hits') {
            const record = sessionOf(session);
            const { api, serviceWorker, reports } = record;
            const snapshot = { api: [...api], serviceWorker: [...serviceWorker], reports: [...reports] };
            if (url.searchParams.get('clear')) { api.length = 0; serviceWorker.length = 0; reports.length = 0; }
            json(res, snapshot);
            return;
        }
        next();
    };
}
