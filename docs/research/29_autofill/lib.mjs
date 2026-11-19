// Shared values and helpers of the research 29 probes: the seeded dummies, the fixed origin they are saved for, the
// browser launch, and one JSON line per result. The server is research 27's (`server.mjs`), reused as it is.
import { mkdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { chromium } from 'playwright';

export { startServer, HTML } from '../27_served_document_headerless/server.mjs';
export { emit } from '../27_served_document_headerless/lib.mjs';

// A saved credential is keyed by its origin, port included, so the host page always runs on this port. Outside the e2e
// range (20000-29999, CONTRIBUTING.md) so that no checkout's suite takes it.
export const PORT = 18929;
// 127.0.0.1, not localhost: the password manager's "Add" dialog refuses `localhost` as a site ("Not a valid web
// address"). Both are potentially trustworthy, so the host page is a secure context either way.
export const HOST_ORIGIN = `http://127.0.0.1:${PORT}`;

// The HTTPS variant: a TLS front on this port that forwards every request to the server on PORT. Its certificate is a
// self-signed one made in the scratch directory (tls/cert.pem, tls/key.pem, tls/spki.txt with the SPKI hash), which
// Chromium accepts as valid with --ignore-certificate-errors-spki-list: no certificate error, so the page counts as
// secure for the features that ask for HTTPS (card autofill).
export const TLS_PORT = 18943;
export const HTTPS_ORIGIN = `https://127.0.0.1:${TLS_PORT}`;

/** The TLS front (see TLS_PORT). Returns its close(). */
export function startTlsFront() {
    const dir = `${process.env.R29_SCRATCH}/tls`;
    const server = https.createServer({ cert: readFileSync(`${dir}/cert.pem`), key: readFileSync(`${dir}/key.pem`) }, (req, res) => {
        const upstream = http.request({ host: '127.0.0.1', port: PORT, path: req.url, method: req.method, headers: req.headers }, (up) => {
            res.writeHead(up.statusCode ?? 502, up.headers);
            up.pipe(res);
        });
        upstream.on('error', () => res.writeHead(502).end());
        req.pipe(upstream);
    });
    return new Promise((resolve) => server.listen(TLS_PORT, '127.0.0.1', () => resolve({ close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) })));
}

/** The flag under which Chromium takes the TLS front's certificate as valid. */
export function tlsArgs() {
    return [`--ignore-certificate-errors-spki-list=${readFileSync(`${process.env.R29_SCRATCH}/tls/spki.txt`, 'utf8').trim()}`];
}

// The dummies saved in the profile. Each is distinctive, so a value seen in a log is unambiguously the saved one.
export const SEED = {
    login: { username: 'r29-user@example.test', password: 'r29-secret-PW-7Q4X' },
    address: {
        name: 'Rtwonine Leakcheck', organization: 'R29 Probe Org', street: '29 Autofill Lane', city: 'Probeville',
        state: 'CA', zip: '94029', phone: '4155550129', email: 'r29-address@example.test',
    },
    card: { number: '5555555555554444', month: '12', year: '2031', cvc: '929', name: 'Rtwonine Cardholder' },
};

/** Every seeded string, for scanning a log for any of them (the phone and card number also in the forms a field shows). */
export const SEEDED_STRINGS = [
    SEED.login.username, SEED.login.password, SEED.address.name, SEED.address.street, SEED.address.city, SEED.address.zip,
    SEED.address.email, '555-0129', '5550129', SEED.card.number, '4444', SEED.card.name, 'r29-typed-note',
];

/**
 * Chromium's autocomplete history: the host page's own form with a field named `r29note`, typed into with real keys and
 * submitted, once, before the cases (run-plain.mjs and run-library.mjs, --seed-history). The value is then offered in any
 * field of that name.
 */
export const HISTORY_SEED_PAGE = '<!doctype html><meta charset="utf-8"><title>r29 history</title><form id="hf" method="get" action="/submitted"><input id="hn" name="r29note"> <button id="hb">Save</button></form>';
export async function seedHistory(p, origin) {
    await p.goto(`${origin}/history-seed`);
    await p.locator('#hn').click();
    await p.keyboard.type('r29-typed-note');
    await p.locator('#hb').click();
    await p.waitForURL(/submitted/);
    await sleep(1000);
}

/** The profile directory: in the scratch directory given on the command line or in R29_SCRATCH, never in the repository. */
export function profileDir(name = 'chromium-profile') {
    const scratch = process.env.R29_SCRATCH;
    if (!scratch) throw new Error('set R29_SCRATCH to a scratch directory outside the repository');
    mkdirSync(scratch, { recursive: true });
    return `${scratch}/${name}`;
}

/**
 * Chromium with the profile. Playwright's defaults already pass --password-store=basic and --use-mock-keychain (the
 * "v10" scheme with a fixed key). `headless: false` runs under the X display xvfb-run provides.
 */
export function launchChromium(dir, { headless = true, args = [], disableFeatures = [], enableFeatures = [] } = {}) {
    // A second --disable-features or --enable-features would replace Playwright's own list, so an extra feature is
    // merged into it.
    const ignoreDefaultArgs = [];
    const all = [...args];
    if (disableFeatures.length) {
        ignoreDefaultArgs.push(PLAYWRIGHT_DISABLED_FEATURES);
        all.push(`${PLAYWRIGHT_DISABLED_FEATURES},${disableFeatures.join(',')}`);
    }
    if (enableFeatures.length) {
        ignoreDefaultArgs.push(PLAYWRIGHT_ENABLED_FEATURES);
        all.push(`${PLAYWRIGHT_ENABLED_FEATURES},${enableFeatures.join(',')}`);
    }
    return chromium.launchPersistentContext(dir, {
        channel: 'chromium', headless, args: all, ignoreDefaultArgs, viewport: { width: 1100, height: 900 },
    });
}

/** Playwright 1.65.1's own --enable-features for Chromium, as chrome://version shows it. */
export const PLAYWRIGHT_ENABLED_FEATURES = '--enable-features=CDPScreenshotNewSurface,SkipListAccountsWithoutGaiaCookies';

/** Playwright 1.65.1's own --disable-features for Chromium, as chrome://version shows it. */
export const PLAYWRIGHT_DISABLED_FEATURES = '--disable-features=AvoidUnnecessaryBeforeUnloadCheckSync,DestroyProfileOnBrowserClose,HttpsUpgrades,HttpsFirstBalancedModeAutoEnable,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,AvoidCorsURLLoaderRestartOnRedirect,TcpPortRandomizationWin,OptimizationHints,NetworkTimeServiceQuerying,AimEnabled,PreconnectToSearch,msForceBrowserSignIn,msEdgeUpdateLaunchServicesPreferredVersion';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const KEYS = { ArrowDown: { code: 'ArrowDown', vk: 40 }, Enter: { code: 'Enter', vk: 13, text: '\r' }, Tab: { code: 'Tab', vk: 9, text: '\t' } };

/**
 * A key press as a real keyboard sends it on Linux: rawKeyDown, then char when the key has text, then keyUp. Playwright's
 * keyboard.press sends a key with text as one `keyDown`, which Chromium's autofill popup does not take as an Enter: with
 * it the popup previewed a suggestion on ArrowDown but never accepted it.
 */
export async function pressKey(cdp, key) {
    const k = KEYS[key];
    const base = { key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk };
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    if (k.text) await cdp.send('Input.dispatchKeyEvent', { type: 'char', ...base, text: k.text, unmodifiedText: k.text });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}
