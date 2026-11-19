// Shared parts of the research 30 probes: the two loopback servers (the host page's and the recorder the opened tab
// reaches), the three engines launched with their popup blockers ON, and the tab observation.
import http from 'node:http';
import { chromium, firefox, webkit } from 'playwright';

// Outside the e2e range (20000-29999, CONTRIBUTING.md) so that no checkout's suite takes them. The host page is on
// `localhost`, the target on `127.0.0.1`: two sites.
export const HOST_PORT = 18930;
export const TARGET_PORT = 18931;
export const HOST_ORIGIN = `http://localhost:${HOST_PORT}`;
export const TARGET_ORIGIN = `http://127.0.0.1:${TARGET_PORT}`;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One JSON line on stdout: the raw results. */
export const emit = (kind, data) => console.log(JSON.stringify({ kind, ...data }));

/**
 * The host page's server, with routes added by path, and the recorder: every request of the target origin is one hit,
 * `{ id, n }` from its query. An opened tab loads `/target`, so a hit is the tab having been opened and navigated.
 * `echo(kind, entry)` is called with every log entry and hit as it arrives (the manual run prints them).
 */
export async function startServers(echo = () => {}) {
    const routes = new Map();
    const hits = [];
    const logs = [];
    const hostServer = http.createServer((req, res) => {
        const url = new URL(req.url, HOST_ORIGIN);
        // the host page reports what it saw (its readiness, each request and each window.open with the activation state)
        // from its own script, so that the probe never evaluates anything in the page: an evaluate can carry a user gesture
        if (req.method === 'POST' && url.pathname === '/log') {
            let body = '';
            req.on('data', (chunk) => { body += chunk; });
            req.on('end', () => { const entry = { id: url.searchParams.get('id'), ...JSON.parse(body) }; logs.push(entry); echo('log', entry); res.writeHead(204).end(); });
            return;
        }
        const route = routes.get(url.pathname);
        if (!route) return void res.writeHead(404).end('not found');
        const out = typeof route === 'function' ? route(url) : route;
        res.writeHead(200, { 'content-type': out.type ?? 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(out.body);
    });
    const targetServer = http.createServer((req, res) => {
        const url = new URL(req.url, TARGET_ORIGIN);
        if (url.pathname === '/target') {
            const hit = { id: url.searchParams.get('id'), n: url.searchParams.get('n') };
            hits.push(hit);
            echo('hit', hit);
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end('<!doctype html><title>target</title><p>target</p>');
    });
    await new Promise((resolve) => hostServer.listen(HOST_PORT, '127.0.0.1', resolve));
    await new Promise((resolve) => targetServer.listen(TARGET_PORT, '127.0.0.1', resolve));
    return {
        route: (path, out) => routes.set(path, out),
        hitsOf: (id) => hits.filter((hit) => hit.id === id),
        logsOf: (id) => logs.filter((entry) => entry.id === id),
        close: () => {
            hostServer.closeAllConnections?.();
            targetServer.closeAllConnections?.();
            hostServer.close();
            targetServer.close();
        },
    };
}

/**
 * Firefox's preferences for a popup blocker as a release build has it. Playwright's own set switches it off
 * (`dom.disable_open_during_load: false`); the others are written out at their release values so that the run does not
 * depend on the build's own defaults.
 */
export const FIREFOX_PREFS = {
    'dom.disable_open_during_load': true,
    'dom.disable_open_click_delay': 1000,
    'dom.popup_maximum': 20,
    'dom.user_activation.transient.timeout': 5000,
    'dom.popup_allowed_events': 'change click dblclick auxclick mouseup pointerup notificationclick reset submit touchend contextmenu',
};

/**
 * The engines. Chromium: Playwright adds `--disable-popup-blocking`, which is removed here. `chromium` is the full
 * build (new headless, or headed under Xvfb), `shell` is the headless shell Playwright uses by default for `headless`.
 */
export const ENGINES = {
    chromium: (headed) => chromium.launch({ channel: 'chromium', headless: !headed, ignoreDefaultArgs: ['--disable-popup-blocking'] }),
    shell: () => chromium.launch({ ignoreDefaultArgs: ['--disable-popup-blocking'] }),
    firefox: (headed) => firefox.launch({ headless: !headed, firefoxUserPrefs: FIREFOX_PREFS }),
    webkit: (headed) => webkit.launch({ headless: !headed }),
};

export const engineName = (key) => (key === 'shell' ? 'chromium' : key);

/** The tabs a context opens, counted by its `page` event. */
export function watchTabs(context) {
    const tabs = [];
    context.on('page', (tab) => tabs.push(tab));
    return tabs;
}
