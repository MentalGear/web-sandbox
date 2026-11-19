// The sequence every host kind runs, whatever opened the page (a browser, a persistent context with an extension,
// Electron): on the host page, the positive controls, the check of the file, and the start-up of F in each case; then
// the library baseline pages. One JSON line per result (research 28's emit).
import { emit } from '../28_served_topology/lib.mjs';

/** What the reach probe aims at: the host page's siblings at `base` (no trailing slash), and the http server's. */
export function targetsFor(base, srv, extra = []) {
    return [
        { name: 'own:secret.txt', url: `${base}/secret.txt`, kind: 'txt' },
        { name: 'own:secret.png', url: `${base}/secret.png`, kind: 'png' },
        { name: 'own:secret.js', url: `${base}/secret.js`, kind: 'js' },
        { name: 'own:sub/secret.txt', url: `${base}/sub/secret.txt`, kind: 'txt' },
        ...extra,
        { name: 'http:secret.txt', url: `${srv.ip}/app/secret.txt`, kind: 'txt' },
        { name: 'http-cors:secret.txt', url: `${srv.ip}/cors/app/secret.txt`, kind: 'txt' },
    ];
}

/** The cases of F: on the host page's own scheme at `base`, and its http copy on the static server (another site). */
export function casesFor(base, srv, targets) {
    const http = `${srv.ip}/app`;
    return [
        { label: 'F on the host scheme, framed as designed', url: `${base}/F.html`, targets },
        { label: 'F without <meta> on the host scheme (browser rules only)', url: `${base}/F-nometa.html`, targets },
        { label: 'F on the host scheme, framed without sandbox', url: `${base}/F.html`, attrs: null, targets, timeout: 8000 },
        { label: 'F on the host scheme, framed with allow-same-origin', url: `${base}/F.html`, attrs: 'allow-scripts allow-forms allow-same-origin', targets, timeout: 8000 },
        { label: 'F on http (another site), framed as designed', url: `${http}/F.html`, targets },
        { label: 'F without <meta> on http (another site)', url: `${http}/F-nometa.html`, targets },
    ];
}

export function checksFor(base, srv) {
    return [
        [`${base}/F.html`, 'F.html', 'the host scheme'],
        [`${srv.ip}/app/F.html`, 'F.html', 'http, no CORS header'],
        [`${srv.ip}/cors/app/F.html`, 'F.html', 'http, Access-Control-Allow-Origin: *'],
    ];
}

const brief = (r) => ({
    end: r.end, ms: r.ms, loads: r.loads, fDom: r.fDom, others: r.others, hostViolations: r.hostViolations,
    F: r.fDiag,
    C: r.announce && { env: r.announce.env.C, hash: r.announce.env.hash, gates: r.announce.verdicts.C.gates, check: r.announce.verdicts.C.check },
    W: r.announce && { started: r.announce.verdicts.W.started, env: r.announce.env.W, gates: r.announce.verdicts.W.gates, check: r.announce.verdicts.W.check },
    portConnected: !!r.hello,
    foreignEvents: r.hello ? [...r.hello.events.C, ...r.hello.events.W].filter((e) => e.policy !== '(the meta, exact)').slice(0, 12) : null,
    reach: r.reach,
});

/** Runs the host page's sequence on `page`, which shows the host page at `hostUrl`. */
export async function runHost(page, tag, kind, { hostUrl, base, srv, extraTargets = [], extraCases = [], libPages = [] }) {
    const console = [];
    page.on('console', (m) => console.push(m.text().slice(0, 200)));
    page.on('pageerror', (e) => console.push('pageerror ' + String(e).slice(0, 200)));
    try {
        await page.goto(hostUrl);
        await page.waitForFunction(() => window.ws34ready === true, null, { timeout: 8000 });
    } catch (e) {
        emit(`${tag}.host`, { kind, hostUrl, loaded: false, error: String(e).slice(0, 300), console: console.slice(0, 20) });
        return;
    }
    const targets = targetsFor(base, srv, extraTargets);
    emit(`${tag}.host`, { kind, hostUrl, loaded: true, env: await page.evaluate(() => window.ws34env()) });
    emit(`${tag}.controls`, { kind, ...(await page.evaluate((t) => window.ws34controls(t), targets)) });
    for (const [url, name, label] of checksFor(base, srv)) emit(`${tag}.check`, { kind, label, ...(await page.evaluate(([u, n]) => window.ws34check(u, n), [url, name])) });
    for (const c of [...casesFor(base, srv, targets), ...extraCases]) {
        const r = await page.evaluate((o) => window.ws34start(o.url, o), c);
        emit(`${tag}.case`, { kind, case: c.label, url: c.url, ...brief(r) });
    }
    emit(`${tag}.console`, { kind, lines: console.filter((l) => /polic|refus|block|denied|not allowed|sandbox|error/i.test(l)).slice(0, 40) });
    for (const lib of libPages) await runLibrary(page, tag, kind, lib);
}

/** The library baseline: one page that starts one sealed app and calls it. */
// Each library page opens in a fresh page of the context where the driver can make one (Electron's cannot): on
// Firefox, a goto from the host page to the file: module page never committed, while the same goto from a fresh page
// loaded it.
export async function runLibrary(hostPage, tag, kind, { label, url }) {
    const fresh = await hostPage.context().newPage().catch(() => null);
    const page = fresh ?? hostPage;
    const console = [];
    const on = (m) => console.push(m.text().slice(0, 220));
    page.on('console', on);
    let out;
    try {
        await page.goto(url, { waitUntil: 'commit' });
        await page.waitForFunction(() => window.libErrors !== undefined, null, { timeout: 10000 }).catch(() => {});
        await page.waitForFunction(() => window.libResult !== undefined, null, { timeout: 22000 }).catch(() => {});
        out = await page.evaluate(() => ({ result: window.libResult ?? 'no result: the library did not run', errors: window.libErrors ?? 'lib-errors.js did not run' }));
    } catch (e) {
        out = { error: String(e).slice(0, 300) };
    }
    page.off('console', on);
    if (fresh) await fresh.close();
    emit(`${tag}.library`, { kind, label, url, freshPage: !!fresh, ...out, console: console.filter((l) => /polic|refus|block|denied|CORS|module|sandbox|error|Failed/i.test(l)).slice(0, 12) });
}

export const libPagesAt = (base) => [
    { label: 'default build as a module (dist/index.js)', url: `${base}/lib-module.html` },
    { label: 'default build as one classic script', url: `${base}/lib-classic.html` },
];
