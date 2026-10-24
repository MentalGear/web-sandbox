import type { Page } from '@playwright/test';
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COOKIES, HOSTS_LINE, hostsResolve, listener, type Acao, type Hit, type Target } from './server';
import { RUNNER, blobCases, cssCases, defeatCases, elementCases, mediaCases, type Case } from './cases';

/**
 * Research 21: what `crossorigin="anonymous"` on every element that loads a URL does to the cookies of those loads, per
 * engine (README.md). Needs one line in /etc/hosts (HOSTS_LINE, below); the test skips without it. Run on its own:
 *
 *   echo '127.0.0.1 app.wsprobe.test cdn.wsprobe.test cross.wsprobe2.test' >> /etc/hosts
 *   bunx playwright test docs/research/21_crossorigin_loads/probe.spec.ts --project=chromium   # then firefox, webkit
 *   bun docs/research/21_crossorigin_loads/summarize.ts                                         # the README's tables
 *
 * The host page is https://app.wsprobe.test (H); the jar holds cookies for H, a sibling (S, cdn.wsprobe.test, the host's
 * own site) and another site (X, cross.wsprobe2.test), SameSite None, Lax and Strict, domain and host-only (server.ts).
 * Each case runs in a sandboxed srcdoc frame without allow-same-origin (an opaque origin, like the strict view), in two
 * structures: `plain` (the frame is a child of the host page: the engine's own behaviour) and `strict` (as the library
 * builds it: a credentialless wrapper frame, the view frame inside it; Chromium only honours the attribute).
 * Results go to results/<engine>-<structure>.json: per case, the page's outcome and the listener's view of each request.
 */

// The browsers read the proxy settings from the environment: a machine with HTTPS_PROXY would send the .test names to it.
for (const name of ['NO_PROXY', 'no_proxy']) process.env[name] = `${process.env[name] ?? ''},.test`;

test.use({ ignoreHTTPSErrors: true });
test.describe.configure({ mode: 'serial' });

const here = path.dirname(fileURLToPath(import.meta.url));
const TARGETS: Target[] = ['H', 'S', 'X'];

type Listener = Awaited<ReturnType<typeof listener>>;

const viewDoc = (cases: Case[], origins: string[], extra = '') => {
    const list = `${origins.join(' ')} ${extra}`.trim();
    const csp = `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline' ${list}; img-src ${list}; media-src ${list}; font-src ${list}`;
    const data = JSON.stringify(cases).replaceAll('<', '\\u003c');
    return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}"><body><script>const CASES = ${data};${RUNNER.replaceAll('</script', '<\\/script')}<\/script></body>`;
};

/** Runs a document in a view-like frame: `plain`, or `strict` (a credentialless wrapper, the view frame inside). */
async function runInFrames(page: Page, struct: 'plain' | 'strict', doc: string, keep = false): Promise<Record<string, any>> {
    return page.evaluate(async ({ struct, doc, keep }) => {
        const got = new Promise<Record<string, any>>(res => addEventListener('message', e => { if (e.data && e.data.results) res(e.data.results); }, { once: true }));
        const frame = document.createElement('iframe');
        frame.id = 'probe-frame';
        frame.style.cssText = 'width:600px;height:400px';
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.setAttribute('referrerpolicy', 'no-referrer');
        if (struct === 'plain') frame.srcdoc = doc;
        else {
            frame.setAttribute('credentialless', '');
            frame.srcdoc = '<!doctype html><body><script>const f = document.createElement("iframe"); f.id = "view"; f.setAttribute("sandbox", "allow-scripts"); f.setAttribute("referrerpolicy", "no-referrer"); f.srcdoc = '
                + JSON.stringify(doc).replaceAll('<', '\\u003c') + '; document.body.append(f)<\/script>';
        }
        document.body.append(frame);
        const results = await Promise.race([got, new Promise<Record<string, any>>(res => setTimeout(() => res({ timeout: { outcome: 'frame-timeout' } }), 40000))]);
        if (!keep) frame.remove();
        return results;
    }, { struct, doc, keep });
}

const slim = (h: Hit) => ({ k: h.k, host: h.host.split('.')[0]!, method: h.method, cookies: h.cookies, origin: h.origin, mode: h.mode, dest: h.dest, site: h.site, range: h.range, status: h.status });

async function batch(page: Page, srv: Listener, struct: 'plain' | 'strict', cases: Case[], extra = '') {
    srv.hits.length = 0;
    const results = await runInFrames(page, struct, viewDoc(cases, TARGETS.map(srv.origin), extra));
    await page.waitForTimeout(300);
    return cases.map(c => ({
        id: c.id, group: c.group, T: c.T, A: c.A, name: c.name, co: c.co,
        result: results[c.id] ?? { outcome: 'missing' },
        hits: srv.hits.filter(h => h.k === c.id || h.k.startsWith(`${c.id}.`)).map(slim),
    }));
}

for (const struct of ['plain', 'strict'] as const) {
    test(`crossorigin matrix, ${struct} frame structure`, async ({ page, context, browserName }) => {
        test.setTimeout(900000);
        test.skip(!(await hostsResolve()), `add this line to /etc/hosts: ${HOSTS_LINE}`);
        const srv = await listener();
        const rows: Awaited<ReturnType<typeof batch>> = [];
        try {
            await context.addCookies(COOKIES);
            await page.goto(`${srv.origin('H')}/host`);
            // the first batch finds out whether the jar reached the listener at all (the control of every other row)
            for (const T of TARGETS) {
                const cases: Case[] = [];
                for (const A of ['cors', 'nocors'] as Acao[]) cases.push(...elementCases(srv.origin, T, A));
                rows.push(...await batch(page, srv, struct, cases));
                const css: Case[] = [];
                for (const A of ['cors', 'nocors'] as Acao[]) css.push(...cssCases(srv.origin, T, A));
                rows.push(...await batch(page, srv, struct, css));
                const defeat: Case[] = [];
                for (const A of ['cors', 'creds'] as Acao[]) defeat.push(...defeatCases(srv.origin, T, A));
                rows.push(...await batch(page, srv, struct, defeat));
            }
            // media: one batch per target (a seek is slow), the real clip when ffmpeg made it
            for (const T of ['X', 'S'] as Target[]) {
                const media: Case[] = [];
                for (const A of ['cors', 'nocors'] as Acao[]) media.push(...mediaCases(srv.origin, T, A));
                rows.push(...await batch(page, srv, struct, media));
            }
        } finally {
            srv.stop();
        }
        mkdirSync(path.join(here, 'results'), { recursive: true });
        writeFileSync(path.join(here, 'results', `${browserName}-${struct}.json`), JSON.stringify({ engine: browserName, struct, video: Boolean(srv.assets.video), realFont: srv.assets.realFont, rows }, null, 1));
        const withCookie = rows.filter(r => r.hits.some(h => h.cookies.length > 0));
        console.log(`PROBE ${browserName} ${struct}: ${rows.length} cases, ${rows.filter(r => r.hits.length > 0).length} reached the listener, ${withCookie.length} carried a cookie`);
        expect(rows.length).toBeGreaterThan(100);
    });
}

// The view's own files are blob: URLs minted in its document (the policy lists blob: for images, media, styles). Does
// the attribute break them? A blob: URL is fetched in CORS mode with it.
for (const struct of ['plain', 'strict'] as const) {
    test(`crossorigin on blob: URLs minted in the view, ${struct} frame structure`, async ({ page, browserName }) => {
        test.setTimeout(120000);
        test.skip(!(await hostsResolve()), `add this line to /etc/hosts: ${HOSTS_LINE}`);
        const srv = await listener();
        try {
            await page.goto(`${srv.origin('H')}/host`);
            const rows = await batch(page, srv, struct, blobCases(), 'blob:');
            mkdirSync(path.join(here, 'results'), { recursive: true });
            writeFileSync(path.join(here, 'results', `${browserName}-blob-${struct}.json`), JSON.stringify({ engine: browserName, struct, rows }, null, 1));
            console.log(`BLOB ${browserName} ${struct} ${rows.map(r => `${r.name}=${r.result.outcome}`).join(' ')}`);
        } finally {
            srv.stop();
        }
    });
}

// Whether a CSS image behind url(… crossorigin(…)) paints, per answer: compares an element screenshot with a blank box.
test('css request modifier: does the image paint', async ({ page, context, browserName }) => {
    test.setTimeout(300000);
    test.skip(!(await hostsResolve()), `add this line to /etc/hosts: ${HOSTS_LINE}`);
    const srv = await listener();
    const out: Record<string, string> = {};
    try {
        await context.addCookies(COOKIES);
        await page.goto(`${srv.origin('H')}/host`);
        for (const A of ['cors', 'nocors'] as Acao[]) {
            const box = (id: string, bg: string) => `<div id="${id}" style="width:20px;height:20px;background:${bg} 0 0/100% 100%;margin:2px"></div>`;
            const u = (id: string) => `${srv.origin('X')}/${A}/a.png?k=${id}`;
            const ids = { plain: `P.${A}.plain`, anon: `P.${A}.anon`, uc: `P.${A}.uc` };
            const html = box('blank', 'none') + box(ids.plain, `url(${u(ids.plain)})`) + box(ids.anon, `url("${u(ids.anon)}" crossorigin(anonymous))`) + box(ids.uc, `url("${u(ids.uc)}" crossorigin(use-credentials))`);
            const doc = viewDoc([{ id: 'x', group: 'P', T: 'X', A, name: 'x', co: '-', wait: 'js', js: `document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(html)}); await sleep(1500); return { outcome: 'n/a' };` }], TARGETS.map(srv.origin));
            srv.hits.length = 0;
            await runInFrames(page, 'plain', doc, true);
            const frame = page.frameLocator('#probe-frame');
            const blank = await frame.locator('[id="blank"]').screenshot();
            for (const [name, id] of Object.entries(ids)) {
                const shot = await frame.locator(`[id="${id}"]`).screenshot();
                const hits = srv.hits.filter(h => h.k === id);
                out[`${A}.${name}`] = `${Buffer.compare(blank, shot) === 0 ? 'blank' : 'painted'}; ${hits.length} request(s): ${hits.map(h => `mode=${h.mode} origin=${h.origin} cookies=[${h.cookies}]`).join(' | ')}`;
            }
            await page.evaluate(() => document.getElementById('probe-frame')!.remove());
        }
    } finally {
        srv.stop();
    }
    mkdirSync(path.join(here, 'results'), { recursive: true });
    writeFileSync(path.join(here, 'results', `${browserName}-paint.json`), JSON.stringify(out, null, 1));
    console.log(`PAINT ${browserName} ${JSON.stringify(out)}`);
});

